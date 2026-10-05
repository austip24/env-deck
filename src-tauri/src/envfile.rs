//! Comment-preserving dotenv parser and upsert writer.
//!
//! One parser is shared by viewing, comparing and writing. It covers the dialect used by
//! dotenvy, Node `dotenv`, Docker and Compose: `export` prefixes, `'single'` (literal),
//! `"double"` (escapes `\n \r \t \" \\`) and `` `backtick` `` quotes, multi-line quoted values
//! and inline `# comments` after unquoted values. Lines that don't parse are kept as
//! [`Line::Other`] so the UI can flag them instead of silently dropping them.
//!
//! [`upsert`] rewrites only the lines of the keys it sets; every other byte of the file,
//! including each line's own terminator, is left untouched.

use std::collections::HashMap;

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::Crlf => "\r\n",
        }
    }

    /// The majority ending in `text` (ties and files without newlines count as LF).
    pub fn detect(text: &str) -> Self {
        let lf = text.matches('\n').count();
        let crlf = text.matches("\r\n").count();
        if crlf > lf - crlf {
            LineEnding::Crlf
        } else {
            LineEnding::Lf
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Quote {
    None,
    Single,
    Double,
    Backtick,
}

/// A `KEY=value` entry. Line numbers are 1-based and inclusive; `end_line > start_line` for
/// multi-line quoted values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub key: String,
    pub value: String,
    pub quote: Quote,
    pub export: bool,
    pub start_line: usize,
    pub end_line: usize,
    /// Trailing comment including its `#`, if any.
    pub inline_comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Line {
    #[serde(rename_all = "camelCase")]
    Blank {
        line: usize,
    },
    #[serde(rename_all = "camelCase")]
    Comment {
        line: usize,
        text: String,
    },
    Pair(Pair),
    #[serde(rename_all = "camelCase")]
    Other {
        start_line: usize,
        end_line: usize,
        raw: String,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    pub lines: Vec<Line>,
    pub line_ending: LineEnding,
    pub trailing_newline: bool,
}

impl Parsed {
    pub fn pairs(&self) -> impl Iterator<Item = &Pair> {
        self.lines.iter().filter_map(|l| match l {
            Line::Pair(p) => Some(p),
            _ => None,
        })
    }

    /// Effective variables: last definition wins, ordered by first appearance.
    pub fn vars(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        let mut index: HashMap<&str, usize> = HashMap::new();
        for p in self.pairs() {
            match index.get(p.key.as_str()) {
                Some(&i) => out[i].1 = p.value.clone(),
                None => {
                    index.insert(&p.key, out.len());
                    out.push((p.key.clone(), p.value.clone()));
                }
            }
        }
        out
    }

    fn unterminated(&self) -> Option<usize> {
        self.lines.iter().find_map(|l| match l {
            Line::Other {
                start_line, reason, ..
            } if reason == UNTERMINATED => Some(*start_line),
            _ => None,
        })
    }
}

/// True for `.env`, `.env.*` and `*.env` file names (case-insensitive).
pub fn is_dotenv_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == ".env" || name.starts_with(".env.") || (name.ends_with(".env") && name.len() > 4)
}

/// True for keys the parser accepts: `[A-Za-z_][A-Za-z0-9_.-]*`.
pub fn is_valid_key(key: &str) -> bool {
    key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

const TEMPLATE_WORDS: &[&str] = &["example", "sample", "template", "dist", "defaults"];

/// True if a dotenv file name marks a template (`.env.example`, `sample.env`, ...).
pub fn is_template_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    is_dotenv_name(&lower) && lower.split('.').any(|seg| TEMPLATE_WORDS.contains(&seg))
}

/// The file a template should become: `.env.example` -> `.env`,
/// `.env.local.sample` -> `.env.local`, `example.env` -> `.env`, `dev.example.env` -> `dev.env`.
pub fn template_target(name: &str) -> Option<String> {
    if !is_template_name(name) {
        return None;
    }
    let kept: Vec<&str> = name
        .split('.')
        .filter(|seg| !TEMPLATE_WORDS.contains(&seg.to_ascii_lowercase().as_str()))
        .collect();
    let target = kept.join(".");
    let target = if target.eq_ignore_ascii_case("env") {
        ".env".to_string()
    } else {
        target
    };
    is_dotenv_name(&target).then_some(target)
}

const UNTERMINATED: &str = "unterminated quoted value";

/// A physical line: content without its terminator, and the terminator (`""` on the last line
/// when the file doesn't end with a newline).
struct RawLine<'a> {
    content: &'a str,
    terminator: &'a str,
}

fn split_lines(text: &str) -> Vec<RawLine<'_>> {
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        match rest.find('\n') {
            Some(i) => {
                let (line, after) = rest.split_at(i + 1);
                let (content, terminator) = match line.strip_suffix("\r\n") {
                    Some(c) => (c, "\r\n"),
                    None => (&line[..line.len() - 1], "\n"),
                };
                out.push(RawLine {
                    content,
                    terminator,
                });
                rest = after;
            }
            None => {
                out.push(RawLine {
                    content: rest,
                    terminator: "",
                });
                rest = "";
            }
        }
    }
    out
}

pub fn parse(text: &str) -> Parsed {
    let raw = split_lines(text);
    Parsed {
        lines: parse_lines(&raw),
        line_ending: LineEnding::detect(text),
        trailing_newline: text.ends_with('\n'),
    }
}

fn is_blank_char(c: char) -> bool {
    c == ' ' || c == '\t'
}

fn parse_lines(raw: &[RawLine]) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let (line, consumed) = parse_entry(raw, i);
        lines.push(line);
        i += consumed;
    }
    lines
}

/// Parses the logical entry starting at physical line `i`; returns it and how many physical
/// lines it spans.
fn parse_entry(raw: &[RawLine], i: usize) -> (Line, usize) {
    let content = raw[i].content;
    let n = i + 1;
    let other = |reason: &str| {
        (
            Line::Other {
                start_line: n,
                end_line: n,
                raw: content.to_string(),
                reason: reason.to_string(),
            },
            1,
        )
    };

    let trimmed = content.trim_start_matches(is_blank_char);
    if trimmed.trim_end().is_empty() {
        return (Line::Blank { line: n }, 1);
    }
    if trimmed.starts_with('#') {
        return (
            Line::Comment {
                line: n,
                text: content.to_string(),
            },
            1,
        );
    }

    let mut rest = trimmed;
    let mut export = false;
    if let Some(after) = rest.strip_prefix("export")
        && after.starts_with(is_blank_char)
    {
        export = true;
        rest = after.trim_start_matches(is_blank_char);
    }

    let key_len = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'))
        .unwrap_or(rest.len());
    let key = &rest[..key_len];
    if !is_valid_key(key) {
        return other("expected KEY=value");
    }
    let after_key = rest[key_len..].trim_start_matches(is_blank_char);
    let Some(value_part) = after_key.strip_prefix('=') else {
        return other("missing '=' after the key");
    };
    let after_eq = value_part;
    let value_part = value_part.trim_start_matches(is_blank_char);

    // `KEY= # note`: whitespace then `#` is a comment, not the value.
    if value_part.starts_with('#') && value_part.len() < after_eq.len() {
        return (
            Line::Pair(Pair {
                key: key.to_string(),
                value: String::new(),
                quote: Quote::None,
                export,
                start_line: n,
                end_line: n,
                inline_comment: Some(value_part.trim_end().to_string()),
            }),
            1,
        );
    }

    let quote = match value_part.chars().next() {
        Some('\'') => Quote::Single,
        Some('"') => Quote::Double,
        Some('`') => Quote::Backtick,
        _ => Quote::None,
    };

    if quote == Quote::None {
        let (value, comment) = split_inline_comment(value_part);
        return (
            Line::Pair(Pair {
                key: key.to_string(),
                value: value.trim_end().to_string(),
                quote,
                export,
                start_line: n,
                end_line: n,
                inline_comment: comment.map(str::to_string),
            }),
            1,
        );
    }

    // Quoted: find the closing quote, possibly on a later line.
    let q = value_part.chars().next().unwrap_or('"');
    let mut body = String::new();
    let mut segment = &value_part[1..];
    let mut j = i;
    loop {
        if let Some(close) = find_close(segment, q) {
            body.push_str(&segment[..close]);
            let tail = segment[close + 1..].trim_matches(is_blank_char);
            let comment = if tail.is_empty() {
                None
            } else if tail.starts_with('#') {
                Some(tail.to_string())
            } else {
                return (
                    Line::Other {
                        start_line: n,
                        end_line: j + 1,
                        raw: join_raw(raw, i, j),
                        reason: "unexpected text after the closing quote".to_string(),
                    },
                    j - i + 1,
                );
            };
            let value = if quote == Quote::Double {
                unescape_double(&body)
            } else {
                body
            };
            return (
                Line::Pair(Pair {
                    key: key.to_string(),
                    value,
                    quote,
                    export,
                    start_line: n,
                    end_line: j + 1,
                    inline_comment: comment,
                }),
                j - i + 1,
            );
        }
        body.push_str(segment);
        j += 1;
        if j >= raw.len() {
            return (
                Line::Other {
                    start_line: n,
                    end_line: j,
                    raw: join_raw(raw, i, j - 1),
                    reason: UNTERMINATED.to_string(),
                },
                j - i,
            );
        }
        body.push('\n');
        segment = raw[j].content;
    }
}

fn join_raw(raw: &[RawLine], from: usize, to: usize) -> String {
    raw[from..=to]
        .iter()
        .map(|l| l.content)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Byte index of the closing `q` in `s`. Inside double quotes a backslash escapes the next char.
fn find_close(s: &str, q: char) -> Option<usize> {
    let mut chars = s.char_indices();
    while let Some((i, c)) = chars.next() {
        if q == '"' && c == '\\' {
            chars.next();
        } else if c == q {
            return Some(i);
        }
    }
    None
}

/// Splits an unquoted value at a `#` preceded by whitespace.
fn split_inline_comment(s: &str) -> (&str, Option<&str>) {
    let bytes = s.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'#' && i > 0 && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            return (&s[..i], Some(s[i..].trim_end()));
        }
    }
    (s, None)
}

fn unescape_double(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn is_bare_safe(c: char) -> bool {
    c.is_ascii_alphanumeric() || "_./:@+,-".contains(c)
}

/// Picks the safest quoting for `value`: bare when possible, single quotes (no interpolation of
/// `$`) when the value has no `'` or newline, otherwise double quotes with escapes.
pub fn quote_value(value: &str) -> String {
    if value.chars().all(is_bare_safe) {
        return value.to_string();
    }
    if !value.contains(['\'', '\n', '\r']) {
        return format!("'{value}'");
    }
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn render_pair(export: bool, key: &str, value: &str, comment: Option<&str>) -> String {
    let mut line = String::new();
    if export {
        line.push_str("export ");
    }
    line.push_str(key);
    line.push('=');
    line.push_str(&quote_value(value));
    if let Some(c) = comment {
        line.push(' ');
        line.push_str(c);
    }
    line
}

/// Sets `vars` in a dotenv `text`.
///
/// An existing key has the span of its **last** definition replaced (keeping `export` and any
/// inline comment); new keys are appended in order. Every other line keeps its exact bytes and
/// terminator; new lines use the file's dominant line ending. Refuses files with an
/// unterminated quote, since appended keys would end up inside it.
pub fn upsert(text: &str, vars: &[(String, String)]) -> Result<String> {
    let raw = split_lines(text);
    let parsed = Parsed {
        lines: parse_lines(&raw),
        line_ending: LineEnding::detect(text),
        trailing_newline: text.ends_with('\n'),
    };
    if let Some(line) = parsed.unterminated() {
        return Err(Error::InvalidDotenv(format!(
            "Line {line} has an unterminated quote; fix it before writing to this file"
        )));
    }
    let ending = parsed.line_ending.as_str();

    let mut last_def: HashMap<&str, &Pair> = HashMap::new();
    for p in parsed.pairs() {
        last_def.insert(&p.key, p);
    }

    // start index (0-based) -> (end index, replacement line)
    let mut replace: HashMap<usize, (usize, String)> = HashMap::new();
    let mut appended: Vec<(String, String)> = Vec::new();
    for (key, value) in vars {
        if let Some(p) = last_def.get(key.as_str()) {
            let line = render_pair(p.export, key, value, p.inline_comment.as_deref());
            replace.insert(p.start_line - 1, (p.end_line - 1, line));
        } else if let Some(existing) = appended.iter_mut().find(|(k, _)| k == key) {
            existing.1 = value.clone();
        } else {
            appended.push((key.clone(), value.clone()));
        }
    }

    let mut out = String::with_capacity(text.len() + 64);
    let mut i = 0;
    while i < raw.len() {
        if let Some((end, line)) = replace.get(&i) {
            out.push_str(line);
            out.push_str(raw[*end].terminator);
            i = end + 1;
        } else {
            out.push_str(raw[i].content);
            out.push_str(raw[i].terminator);
            i += 1;
        }
    }

    if !appended.is_empty() {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push_str(ending);
        }
        for (key, value) in &appended {
            out.push_str(&render_pair(false, key, value, None));
            out.push_str(ending);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(text: &str) -> Pair {
        let parsed = parse(text);
        match parsed.lines.into_iter().next() {
            Some(Line::Pair(p)) => p,
            other => panic!("expected a pair for {text:?}, got {other:?}"),
        }
    }

    fn vars(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn bare_values() {
        let p = pair("KEY=value");
        assert_eq!((p.key.as_str(), p.value.as_str()), ("KEY", "value"));
        assert_eq!(p.quote, Quote::None);
        assert_eq!(pair("KEY = spaced value  ").value, "spaced value");
        assert_eq!(pair("KEY=").value, "");
        assert_eq!(pair("KEY=a=b==").value, "a=b==");
        assert_eq!(pair("  INDENTED=1").value, "1");
        assert_eq!(pair("dotted.key-name=1").key, "dotted.key-name");
    }

    #[test]
    fn inline_comments() {
        let p = pair("KEY=value # note");
        assert_eq!(p.value, "value");
        assert_eq!(p.inline_comment.as_deref(), Some("# note"));
        // A comment straight after `= ` leaves the value empty (dotenv, Node, Compose agree).
        let p = pair("SENTRY_DSN= # added later");
        assert_eq!(p.value, "");
        assert_eq!(p.inline_comment.as_deref(), Some("# added later"));
        assert_eq!(pair("A=\t#c").value, "");
        // '#' without preceding whitespace is part of the value.
        assert_eq!(pair("COLOR=#fff").value, "#fff");
        assert_eq!(pair("URL=http://x/#frag").value, "http://x/#frag");
        // '#' inside quotes is part of the value.
        let p = pair("KEY='a # b' # c");
        assert_eq!(p.value, "a # b");
        assert_eq!(p.inline_comment.as_deref(), Some("# c"));
    }

    #[test]
    fn quoting_styles() {
        let p = pair("A='$HOME \\n'");
        assert_eq!((p.value.as_str(), p.quote), ("$HOME \\n", Quote::Single));
        let p = pair(r#"A="line\nnext\t\"q\" \\ \x""#);
        assert_eq!(p.value, "line\nnext\t\"q\" \\ \\x");
        assert_eq!(p.quote, Quote::Double);
        let p = pair("A=`it's \"raw\"`");
        assert_eq!(
            (p.value.as_str(), p.quote),
            ("it's \"raw\"", Quote::Backtick)
        );
        assert_eq!(pair("A=\"\"").value, "");
    }

    #[test]
    fn export_prefix() {
        let p = pair("export KEY=1");
        assert!(p.export);
        assert_eq!(p.key, "KEY");
        let p = pair("export\tKEY='x'");
        assert!(p.export);
        // A key that merely starts with "export" is not a prefix.
        let p = pair("exported=1");
        assert!(!p.export);
        assert_eq!(p.key, "exported");
    }

    #[test]
    fn comments_blanks_and_invalid_lines() {
        let parsed = parse("# top\n\n   \nnot a pair\n1BAD=x\nexport\nOK=1\n");
        let kinds: Vec<&str> = parsed
            .lines
            .iter()
            .map(|l| match l {
                Line::Blank { .. } => "blank",
                Line::Comment { .. } => "comment",
                Line::Pair(_) => "pair",
                Line::Other { .. } => "other",
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "comment", "blank", "blank", "other", "other", "other", "pair"
            ]
        );
        let Line::Other {
            raw, start_line, ..
        } = &parsed.lines[3]
        else {
            panic!()
        };
        assert_eq!((raw.as_str(), *start_line), ("not a pair", 4));
    }

    #[test]
    fn multiline_pem() {
        let text = "BEFORE=1\nKEY=\"-----BEGIN KEY-----\nabc\n-----END KEY-----\"\nAFTER=2\n";
        let parsed = parse(text);
        let pairs: Vec<&Pair> = parsed.pairs().collect();
        assert_eq!(pairs.len(), 3);
        assert_eq!(
            pairs[1].value,
            "-----BEGIN KEY-----\nabc\n-----END KEY-----"
        );
        assert_eq!((pairs[1].start_line, pairs[1].end_line), (2, 4));
        assert_eq!(pairs[2].start_line, 5);
        // Single-quoted multi-line works too, and CRLF content is normalised to \n.
        let p = pair("K='a\r\nb'\r\n");
        assert_eq!(p.value, "a\nb");
    }

    #[test]
    fn unterminated_quote_is_flagged() {
        let parsed = parse("A=1\nB=\"open\nC=2\n");
        assert_eq!(parsed.pairs().count(), 1);
        let Line::Other {
            start_line,
            end_line,
            reason,
            ..
        } = &parsed.lines[1]
        else {
            panic!("{:?}", parsed.lines)
        };
        assert_eq!(
            (*start_line, *end_line, reason.as_str()),
            (2, 3, UNTERMINATED)
        );
        assert!(upsert("A=1\nB=\"open\n", &vars(&[("A", "2")])).is_err());
    }

    #[test]
    fn text_after_closing_quote_is_flagged() {
        let parsed = parse("A='x' y\n");
        assert!(matches!(parsed.lines[0], Line::Other { .. }));
    }

    #[test]
    fn duplicates_last_wins() {
        let parsed = parse("A=1\nB=2\nA=3\n");
        assert_eq!(parsed.vars(), vars(&[("A", "3"), ("B", "2")]));
    }

    #[test]
    fn line_endings() {
        assert_eq!(parse("A=1\r\nB=2\r\n").line_ending, LineEnding::Crlf);
        assert_eq!(parse("A=1\nB=2\n").line_ending, LineEnding::Lf);
        assert_eq!(parse("A=1").line_ending, LineEnding::Lf);
        assert_eq!(parse("A=1\r\nB=2\r\nC=3\n").line_ending, LineEnding::Crlf);
        assert!(!parse("A=1").trailing_newline);
        assert!(parse("A=1\n").trailing_newline);
    }

    #[test]
    fn quote_value_choices() {
        assert_eq!(
            quote_value("plain-value_1.2/x:y@z+,"),
            "plain-value_1.2/x:y@z+,"
        );
        assert_eq!(quote_value(""), "");
        assert_eq!(quote_value("$HOME"), "'$HOME'");
        assert_eq!(quote_value("a b"), "'a b'");
        assert_eq!(quote_value("it's"), "\"it's\"");
        assert_eq!(quote_value("a\nb"), "\"a\\nb\"");
    }

    #[test]
    fn quote_value_round_trips() {
        let corpus = [
            "",
            "simple",
            "$HOME",
            "${OTHER}",
            "a b",
            "  padded  ",
            "it's",
            "say \"hi\"",
            "it's \"both\"",
            "line1\nline2",
            "crlf\r\nvalue",
            "tab\there",
            "# not a comment",
            "a #b",
            "back\\slash",
            "back\\n literal",
            "trailing\\",
            "`tick`",
            "ünïcødé ✓",
            "base64+/==",
            "postgres://user:p@ss@host:5432/db?x=1&y=2",
            "-----BEGIN KEY-----\nabc\n-----END KEY-----\n",
        ];
        for v in corpus {
            let line = format!("KEY={}", quote_value(v));
            assert_eq!(pair(&line).value, v, "round trip of {v:?} via {line:?}");
            // Also as the last line of a file with a trailing newline and an export prefix.
            let line = format!("export KEY={}\n", quote_value(v));
            assert_eq!(pair(&line).value, v, "round trip of {v:?} via {line:?}");
        }
    }

    #[test]
    fn upsert_replaces_only_the_key() {
        let text = "# Database\nexport DB_URL=old # primary\n\nOTHER = keep  me \nweird line\n";
        let out = upsert(text, &vars(&[("DB_URL", "postgres://x")])).unwrap();
        assert_eq!(
            out,
            "# Database\nexport DB_URL=postgres://x # primary\n\nOTHER = keep  me \nweird line\n"
        );
    }

    #[test]
    fn upsert_appends_new_keys_in_order() {
        let out = upsert(
            "A=1\n",
            &vars(&[("B", "two words"), ("C", "3"), ("A", "9")]),
        )
        .unwrap();
        assert_eq!(out, "A=9\nB='two words'\nC=3\n");
        // No trailing newline: one is added before appending.
        assert_eq!(upsert("A=1", &vars(&[("B", "2")])).unwrap(), "A=1\nB=2\n");
        assert_eq!(upsert("", &vars(&[("B", "2")])).unwrap(), "B=2\n");
        // The same key twice in one call: last value wins.
        assert_eq!(
            upsert("", &vars(&[("B", "1"), ("B", "2")])).unwrap(),
            "B=2\n"
        );
    }

    #[test]
    fn upsert_preserves_crlf() {
        let out = upsert("A=1\r\nB=2\r\n", &vars(&[("B", "3"), ("C", "4")])).unwrap();
        assert_eq!(out, "A=1\r\nB=3\r\nC=4\r\n");
        let out = upsert("A=1\r\nB=2", &vars(&[("C", "4")])).unwrap();
        assert_eq!(out, "A=1\r\nB=2\r\nC=4\r\n");
    }

    #[test]
    fn upsert_keeps_mixed_terminators_of_untouched_lines() {
        let text = "A=1\r\nB=2\nC=3\r\n";
        let out = upsert(text, &vars(&[("B", "x")])).unwrap();
        assert_eq!(out, "A=1\r\nB=x\nC=3\r\n");
    }

    #[test]
    fn upsert_replaces_last_duplicate_only() {
        let out = upsert("A=1\nB=2\nA=3\n", &vars(&[("A", "4")])).unwrap();
        assert_eq!(out, "A=1\nB=2\nA=4\n");
    }

    #[test]
    fn upsert_replaces_whole_multiline_span() {
        let text = "X=1\r\nKEY=\"-----BEGIN-----\r\nabc\r\n-----END-----\"\r\nY=2\r\n";
        let out = upsert(text, &vars(&[("KEY", "new\nvalue")])).unwrap();
        assert_eq!(out, "X=1\r\nKEY=\"new\\nvalue\"\r\nY=2\r\n");
        let reparsed = parse(&out);
        assert_eq!(
            reparsed.vars(),
            vars(&[("X", "1"), ("KEY", "new\nvalue"), ("Y", "2")])
        );
    }

    #[test]
    fn upsert_with_no_changes_is_byte_identical() {
        let text = "# c\r\n\r\nexport A='x' # y\nB=\"m\nl\"\nbad\n";
        assert_eq!(upsert(text, &[]).unwrap(), text);
    }

    #[test]
    fn keys_and_templates() {
        assert!(is_valid_key("A_B.c-d") && is_valid_key("_x"));
        assert!(
            !is_valid_key("")
                && !is_valid_key("1A")
                && !is_valid_key("A B")
                && !is_valid_key("A=B")
        );
        let cases = [
            (".env.example", Some(".env")),
            (".env.local.sample", Some(".env.local")),
            (".ENV.Template", Some(".ENV")),
            ("example.env", Some(".env")),
            ("dev.example.env", Some("dev.env")),
            (".env.dist", Some(".env")),
            (".env", None),
            (".env.local", None),
            ("appsettings.example.json", None),
        ];
        for (name, target) in cases {
            assert_eq!(template_target(name).as_deref(), target, "{name}");
        }
    }

    #[test]
    fn dotenv_names() {
        for name in [
            ".env",
            ".env.local",
            ".ENV.Production",
            "dev.env",
            ".env.example",
        ] {
            assert!(is_dotenv_name(name), "{name}");
        }
        for name in [
            ".envrc",
            "env",
            ".env-file",
            "appsettings.json",
            ".npmrc",
            ".env_x",
        ] {
            assert!(!is_dotenv_name(name), "{name}");
        }
    }

    #[test]
    fn serialises_for_the_ui() {
        let json = serde_json::to_value(parse("export A=1 # c\n")).unwrap();
        assert_eq!(json["lineEnding"], "lf");
        assert_eq!(json["lines"][0]["type"], "pair");
        assert_eq!(json["lines"][0]["startLine"], 1);
        assert_eq!(json["lines"][0]["inlineComment"], "# c");
    }
}
