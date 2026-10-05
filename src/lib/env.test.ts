import { describe, expect, it } from "vitest";
import type { ParsedEnv } from "@/lib/ipc";
import {
  compareEnv,
  effectiveVars,
  formatVars,
  isSecret,
  isSecretKey,
  isSecretValue,
  overriddenLines,
  quoteDotenv,
  quotePosix,
  quotePowerShell,
  secretSpanInLine,
  isBackupName,
  isDotenvName,
  planSend,
  templateTarget,
  withLineEnding,
} from "./env";

function parsed(pairs: [string, string, number][]): ParsedEnv {
  return {
    lineEnding: "lf",
    trailingNewline: true,
    lines: pairs.map(([key, value, line]) => ({
      type: "pair",
      key,
      value,
      quote: "none",
      export: false,
      startLine: line,
      endLine: line,
      inlineComment: null,
    })),
  };
}

describe("secret detection", () => {
  it("flags secret-looking keys by word", () => {
    for (const k of [
      "STRIPE_SECRET_KEY",
      "API_KEY",
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "SENTRY_DSN",
      "JWT_PRIVATE_KEY",
      "apiKey",
      "stripe.secretKey",
      "aws-credentials",
      "SESSION_SECRET",
      "BASIC_AUTH",
    ]) {
      expect(isSecretKey(k), k).toBe(true);
    }
  });

  it("leaves ordinary keys alone", () => {
    for (const k of ["PORT", "NODE_ENV", "KEYBOARD_LAYOUT", "MONKEY_COUNT", "LOG_LEVEL", "DATABASE_URL", "AUTHOR"]) {
      expect(isSecretKey(k), k).toBe(false);
    }
  });

  it("flags secret-looking values", () => {
    expect(isSecretValue("postgres://shop:hunter2@localhost:5432/shop")).toBe(true);
    expect(isSecretValue("redis://:pw@cache:6379")).toBe(true);
    expect(isSecretValue("-----BEGIN RSA PRIVATE KEY-----\nabc")).toBe(true);
    expect(isSecretValue("Server=db;User Id=sa;Password=x")).toBe(true);
    expect(isSecretValue("http://localhost:4000")).toBe(false);
    expect(isSecretValue("https://user@host/path")).toBe(false);
  });

  it("doesn't mask empty values", () => {
    expect(isSecret("API_KEY", "")).toBe(false);
    expect(isSecret("API_KEY", "x")).toBe(true);
    expect(isSecret("URL", "postgres://a:b@h/db")).toBe(true);
  });
});

describe("parsed helpers", () => {
  const p = parsed([
    ["A", "1", 1],
    ["B", "2", 2],
    ["A", "3", 3],
  ]);

  it("last definition wins, first-appearance order", () => {
    expect(effectiveVars(p)).toEqual([
      { key: "A", value: "3" },
      { key: "B", value: "2" },
    ]);
  });

  it("reports overridden definitions", () => {
    expect([...overriddenLines(p)]).toEqual([1]);
  });
});

describe("compareEnv", () => {
  it("classifies keys", () => {
    const rows = compareEnv(
      [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
        { key: "C", value: "3" },
      ],
      [
        { key: "B", value: "2" },
        { key: "C", value: "x" },
        { key: "D", value: "4" },
      ],
    );
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ["A", "onlyA"],
      ["B", "same"],
      ["C", "differs"],
      ["D", "onlyB"],
    ]);
    expect(rows[3]).toMatchObject({ a: null, b: "4" });
  });
});

describe("quoting", () => {
  it("dotenv quoting mirrors envfile::quote_value", () => {
    expect(quoteDotenv("plain-1.2/x:y@z+,")).toBe("plain-1.2/x:y@z+,");
    expect(quoteDotenv("")).toBe("");
    expect(quoteDotenv("$HOME")).toBe("'$HOME'");
    expect(quoteDotenv("it's")).toBe(`"it's"`);
    expect(quoteDotenv('a\nb"c\\')).toBe('"a\\nb\\"c\\\\"');
  });

  it("POSIX single quotes escape embedded quotes", () => {
    expect(quotePosix("simple")).toBe("simple");
    expect(quotePosix("")).toBe("''");
    expect(quotePosix("$HOME and `cmd`")).toBe("'$HOME and `cmd`'");
    expect(quotePosix("it's")).toBe(`'it'\\''s'`);
  });

  it("PowerShell single quotes double embedded quotes", () => {
    expect(quotePowerShell("$env:PATH")).toBe("'$env:PATH'");
    expect(quotePowerShell("it's")).toBe("'it''s'");
  });
});

describe("formatVars", () => {
  const vars = [
    { key: "PORT", value: "4000" },
    { key: "GREETING", value: "it's $HOME" },
  ];

  it("dotenv", () => {
    expect(formatVars(vars, "dotenv").text).toBe(`PORT=4000\nGREETING="it's $HOME"\n`);
  });

  it("export", () => {
    expect(formatVars(vars, "export").text).toBe(`export PORT=4000\nexport GREETING='it'\\''s $HOME'\n`);
    expect(formatVars([{ key: "a.b", value: "1" }], "export").warnings).toHaveLength(1);
  });

  it("powershell", () => {
    expect(formatVars(vars, "powershell").text).toBe(`$env:PORT = '4000'\n$env:GREETING = 'it''s $HOME'\n`);
    expect(formatVars([{ key: "a.b", value: "1" }], "powershell").text).toBe("${env:a.b} = '1'\n");
  });

  it("cmd", () => {
    const out = formatVars([{ key: "P", value: "100%" }, ...vars], "cmd");
    expect(out.text).toBe(`set "P=100%"\nset "PORT=4000"\nset "GREETING=it's $HOME"\n`);
    expect(out.warnings).toEqual([`cmd.exe may change values containing %, ! or ": P`]);
  });

  it("json", () => {
    expect(JSON.parse(formatVars(vars, "json").text)).toEqual({ PORT: "4000", GREETING: "it's $HOME" });
  });

  it("docker", () => {
    expect(formatVars(vars, "docker").text).toBe(`-e PORT=4000 -e 'GREETING=it'\\''s $HOME'\n`);
  });

  it("warns about multi-line values in shell formats only", () => {
    const ml = [{ key: "PEM", value: "a\nb" }];
    expect(formatVars(ml, "export").warnings).toHaveLength(1);
    expect(formatVars(ml, "dotenv").warnings).toHaveLength(0);
    expect(formatVars(ml, "json").warnings).toHaveLength(0);
  });

  it("empty selection", () => {
    expect(formatVars([], "dotenv").text).toBe("");
  });
});

describe("secretSpanInLine", () => {
  const masked = (line: string, kind: Parameters<typeof secretSpanInLine>[1]) => {
    const s = secretSpanInLine(line, kind);
    return s ? line.slice(0, s.start) + "***" + line.slice(s.end) : line;
  };

  it("json", () => {
    expect(masked(`    "Password": "hunter2",`, "json")).toBe(`    "Password": "***",`);
    expect(masked(`  "Default": "Server=db;Password=x"`, "json")).toBe(`  "Default": "***"`);
    expect(masked(`  "Port": "5432",`, "json")).toBe(`  "Port": "5432",`);
    expect(masked(`  "apiKey": "a\\"b"`, "json")).toBe(`  "apiKey": "***"`);
  });

  it("yaml", () => {
    expect(masked("  password: hunter2", "yaml")).toBe("  password: ***");
    expect(masked("  token: 'abc' # note", "yaml")).toBe("  token: '***' # note");
    expect(masked("  - API_KEY: x", "yaml")).toBe("  - API_KEY: ***");
    expect(masked("  image: postgres:16", "yaml")).toBe("  image: postgres:16");
    expect(masked("  url: postgres://u:p@h/db", "yaml")).toBe("  url: ***");
  });

  it("ini, toml and .npmrc", () => {
    expect(masked("//registry.npmjs.org/:_authToken=abc123", "ini")).toBe("//registry.npmjs.org/:_authToken=***");
    expect(masked(`secret_key = "abc"`, "toml")).toBe(`secret_key = "***"`);
    expect(masked("save-exact=true", "ini")).toBe("save-exact=true");
    expect(masked("[section]", "ini")).toBe("[section]");
  });

  it("text is left alone", () => {
    expect(secretSpanInLine("password=x", "text")).toBeNull();
  });
});

describe("writing helpers", () => {
  it("templateTarget mirrors envfile::template_target", () => {
    expect(templateTarget(".env.example")).toBe(".env");
    expect(templateTarget(".env.local.sample")).toBe(".env.local");
    expect(templateTarget("example.env")).toBe(".env");
    expect(templateTarget("dev.example.env")).toBe("dev.env");
    expect(templateTarget(".env")).toBeNull();
    expect(templateTarget("appsettings.example.json")).toBeNull();
  });

  it("isBackupName", () => {
    for (const n of [".env.bak-1791141433", ".env.bak-1791141433-2", ".env.copy", ".env.copy-3"]) {
      expect(isBackupName(n), n).toBe(true);
    }
    for (const n of [".env", ".env.local", ".env.copycat", ".env.backup"]) expect(isBackupName(n), n).toBe(false);
  });

  it("isDotenvName", () => {
    expect(isDotenvName(".env.local") && isDotenvName("dev.env") && isDotenvName(".ENV")).toBe(true);
    expect(isDotenvName(".envrc") || isDotenvName(".npmrc")).toBe(false);
  });

  it("withLineEnding", () => {
    expect(withLineEnding("A=1\nB=2\n", "crlf")).toBe("A=1\r\nB=2\r\n");
    expect(withLineEnding("A=1\r\nB=2\n", "lf")).toBe("A=1\nB=2\n");
    expect(withLineEnding("A=1\r\nB=2\n", "crlf")).toBe("A=1\r\nB=2\r\n");
  });

  it("planSend", () => {
    const plan = planSend(
      [
        { key: "A", value: "1" },
        { key: "B", value: "new" },
        { key: "C", value: "3" },
      ],
      [
        { key: "A", value: "1" },
        { key: "B", value: "old" },
      ],
    );
    expect(plan.same.map((v) => v.key)).toEqual(["A"]);
    expect(plan.replace).toEqual([{ key: "B", value: "new", previous: "old" }]);
    expect(plan.add.map((v) => v.key)).toEqual(["C"]);
  });
});
