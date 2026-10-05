// Keeps the mock's dotenv port honest against the same cases as envfile.rs, so `dev:mock`
// behaves like the real app.
import { describe, expect, it } from "vitest";
import type { EnvLine } from "@/lib/ipc";
import { kindOf, parseEnv, quoteValue, templateTarget, upsert } from "./mock-dotenv";

const pairs = (text: string) =>
  parseEnv(text).lines.filter((l): l is Extract<EnvLine, { type: "pair" }> => l.type === "pair");

describe("mock dotenv parser", () => {
  it("parses quoting, export and inline comments", () => {
    const [a, b, c, d, e] = pairs(
      "export A=1 # note\nB='$HOME x'\nC=\"l1\\nl2 \\\"q\\\"\"\nD=#fff\nE=`it's`\n",
    );
    expect(a).toMatchObject({ key: "A", value: "1", export: true, inlineComment: "# note" });
    expect(b.value).toBe("$HOME x");
    expect(c.value).toBe('l1\nl2 "q"');
    expect(d.value).toBe("#fff");
    expect(pairs("DSN= # later")[0]).toMatchObject({ value: "", inlineComment: "# later" });
    expect(e.value).toBe("it's");
  });

  it("handles multi-line values and flags invalid lines", () => {
    const parsed = parseEnv('A=1\r\nK="-----BEGIN-----\r\nabc\r\n-----END-----"\r\nnope\r\n');
    expect(parsed.lineEnding).toBe("crlf");
    const k = pairs('A=1\nK="-----BEGIN-----\nabc\n-----END-----"\n')[1];
    expect(k).toMatchObject({ value: "-----BEGIN-----\nabc\n-----END-----", startLine: 2, endLine: 4 });
    expect(parsed.lines.at(-1)).toMatchObject({ type: "other", startLine: 5 });
  });

  it("round-trips quote_value", () => {
    for (const v of ["", "plain", "$HOME", "a b", "it's", 'say "hi"', "l1\nl2", "back\\slash", "# x"]) {
      expect(pairs(`K=${quoteValue(v)}`)[0].value).toBe(v);
    }
  });

  it("upserts like envfile::upsert", () => {
    expect(upsert("# c\r\nA=1 # keep\r\nB=2", [{ key: "A", value: "x y" }, { key: "C", value: "3" }])).toBe(
      "# c\r\nA='x y' # keep\r\nB=2\r\nC=3\r\n",
    );
    expect(() => upsert('A="open\n', [{ key: "A", value: "1" }])).toThrow();
  });

  it("matches kinds and template targets", () => {
    expect(kindOf(".env.example")).toBe("env-template");
    expect(kindOf(".env.local")).toBe("env");
    expect(kindOf("appsettings.json")).toBe("json");
    expect(kindOf(".npmrc")).toBe("ini");
    expect(templateTarget(".env.local.sample")).toBe(".env.local");
    expect(templateTarget("example.env")).toBe(".env");
    expect(templateTarget(".env")).toBeNull();
  });
});
