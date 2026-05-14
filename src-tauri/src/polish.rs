use crate::focus_context::FocusContext;
use strsim::levenshtein;

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum AppProfile {
    Default,
    Email,
    Docs,
    Chat,
    CodeComment,
    Terminal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SpokenCommand {
    UndoLast,
    InsertNewLine,
    InsertNewParagraph,
    DeleteLastSentence,
    OpenApp { query: String },
    TakeNote { content: Option<String> },
}

impl AppProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            AppProfile::Default => "default",
            AppProfile::Email => "email",
            AppProfile::Docs => "docs",
            AppProfile::Chat => "chat",
            AppProfile::CodeComment => "code_comment",
            AppProfile::Terminal => "terminal",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_lowercase().as_str() {
            "default" => Some(AppProfile::Default),
            "email" => Some(AppProfile::Email),
            "docs" | "doc" | "document" => Some(AppProfile::Docs),
            "chat" | "messaging" => Some(AppProfile::Chat),
            "code" | "code_comment" | "comment" => Some(AppProfile::CodeComment),
            "terminal" | "shell" | "cli" => Some(AppProfile::Terminal),
            _ => None,
        }
    }
}

pub fn infer_profile(context: Option<&FocusContext>) -> AppProfile {
    let mut haystack = String::new();
    if let Some(ctx) = context {
        if let Some(app) = &ctx.app_name {
            haystack.push_str(app);
            haystack.push(' ');
        }
        if let Some(id) = &ctx.app_identifier {
            haystack.push_str(id);
            haystack.push(' ');
        }
        if let Some(title) = &ctx.window_title {
            haystack.push_str(title);
        }
    }

    let haystack = haystack.to_lowercase();
    if haystack.is_empty() {
        return AppProfile::Default;
    }

    if matches_any(&haystack, &["mail", "outlook", "gmail", "thunderbird"]) {
        return AppProfile::Email;
    }
    if matches_any(&haystack, &["notion", "docs", "word", "pages", "notes"]) {
        return AppProfile::Docs;
    }
    if matches_any(
        &haystack,
        &[
            "slack", "discord", "messages", "teams", "telegram", "whatsapp", "signal",
        ],
    ) {
        return AppProfile::Chat;
    }
    if matches_any(
        &haystack,
        &["terminal", "iterm", "warp", "powershell", "cmd.exe"],
    ) {
        return AppProfile::Terminal;
    }
    if matches_any(
        &haystack,
        &[
            "code", "vscode", "xcode", "intellij", "pycharm", "webstorm", "clion", "sublime",
            "neovim", "vim",
        ],
    ) {
        return AppProfile::CodeComment;
    }

    AppProfile::Default
}

pub fn resolve_profile(
    context: Option<&FocusContext>,
    overrides: &std::collections::HashMap<String, String>,
) -> AppProfile {
    if let Some(ctx) = context {
        if let Some(profile) = override_for_context(ctx, overrides) {
            return profile;
        }
    }
    infer_profile(context)
}

fn matches_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn convert_number_words(input: &str) -> String {
    #[derive(Clone)]
    struct Token {
        leading: String,
        core: String,
        core_lower: String,
        trailing: String,
    }

    fn split_token(token: &str) -> Token {
        let mut start = token.len();
        let mut end = token.len();

        for (idx, ch) in token.char_indices() {
            if ch.is_alphanumeric() || ch == '-' || ch == '\'' {
                start = idx;
                break;
            }
        }

        if start < token.len() {
            for (idx, ch) in token.char_indices().rev() {
                if ch.is_alphanumeric() || ch == '-' || ch == '\'' {
                    end = idx + ch.len_utf8();
                    break;
                }
            }
        }

        let leading = token[..start].to_string();
        let core = token[start..end].to_string();
        let trailing = token[end..].to_string();
        let core_lower = core.to_lowercase();
        Token {
            leading,
            core,
            core_lower,
            trailing,
        }
    }

    fn word_value(word: &str) -> Option<i64> {
        match word {
            "zero" => Some(0),
            "one" => Some(1),
            "two" => Some(2),
            "three" => Some(3),
            "four" => Some(4),
            "five" => Some(5),
            "six" => Some(6),
            "seven" => Some(7),
            "eight" => Some(8),
            "nine" => Some(9),
            "ten" => Some(10),
            "eleven" => Some(11),
            "twelve" => Some(12),
            "thirteen" => Some(13),
            "fourteen" => Some(14),
            "fifteen" => Some(15),
            "sixteen" => Some(16),
            "seventeen" => Some(17),
            "eighteen" => Some(18),
            "nineteen" => Some(19),
            "twenty" => Some(20),
            "thirty" => Some(30),
            "forty" => Some(40),
            "fifty" => Some(50),
            "sixty" => Some(60),
            "seventy" => Some(70),
            "eighty" => Some(80),
            "ninety" => Some(90),
            _ => None,
        }
    }

    fn is_unit_word(word: &str) -> bool {
        matches!(
            word,
            "percent" | "percentage" | "dollar" | "dollars" | "buck" | "bucks"
        )
    }

    fn apply_unit(value: i64, unit: &str) -> String {
        match unit {
            "percent" | "percentage" => format!("{}%", value),
            "dollar" | "dollars" | "buck" | "bucks" => format!("${}", value),
            _ => value.to_string(),
        }
    }

    fn parse_number_sequence(
        tokens: &[Token],
        start: usize,
    ) -> Option<(usize, i64, usize, bool, bool)> {
        let mut idx = start;
        let mut total = 0i64;
        let mut current = 0i64;
        let mut seen = false;
        let mut word_count = 0usize;
        let mut has_multiplier = false;
        let mut has_tens = false;

        while idx < tokens.len() {
            let core = tokens[idx].core_lower.as_str();
            if core.is_empty() {
                break;
            }

            let mut consumed = false;
            for part in core.split('-') {
                if part == "and" {
                    if seen {
                        consumed = true;
                        continue;
                    }
                    return None;
                }
                if let Some(val) = word_value(part) {
                    if val >= 20 {
                        has_tens = true;
                    }
                    current += val;
                    seen = true;
                    word_count += 1;
                    consumed = true;
                    continue;
                }
                if part == "hundred" {
                    if current == 0 {
                        current = 1;
                    }
                    current *= 100;
                    seen = true;
                    has_multiplier = true;
                    consumed = true;
                    continue;
                }
                if part == "thousand" {
                    if current == 0 {
                        current = 1;
                    }
                    total += current * 1000;
                    current = 0;
                    seen = true;
                    has_multiplier = true;
                    consumed = true;
                    continue;
                }
                if !consumed {
                    break;
                }
                consumed = false;
                break;
            }

            if !consumed {
                break;
            }
            idx += 1;
        }

        if seen {
            Some((idx, total + current, word_count, has_multiplier, has_tens))
        } else {
            None
        }
    }

    let raw_tokens: Vec<&str> = input.split_whitespace().collect();
    if raw_tokens.is_empty() {
        return input.to_string();
    }

    let tokens: Vec<Token> = raw_tokens.iter().map(|t| split_token(t)).collect();
    let mut out: Vec<String> = Vec::with_capacity(tokens.len());
    let mut idx = 0;

    fn convert_single_token(tokens: &[Token], idx: usize) -> Option<(String, usize)> {
        let token = &tokens[idx];
        let value = word_value(token.core_lower.as_str())?;

        let mut unit_value = None;
        let mut unit_trailing = String::new();
        let mut unit_leading = String::new();
        if idx + 1 < tokens.len() {
            let unit_core = tokens[idx + 1].core_lower.as_str();
            if is_unit_word(unit_core) {
                unit_value = Some(unit_core.to_string());
                unit_trailing = tokens[idx + 1].trailing.clone();
                unit_leading = tokens[idx + 1].leading.clone();
            }
        }

        let has_unit = unit_value.is_some();
        let should_convert = has_unit || value >= 10;
        if !should_convert {
            return None;
        }

        let mut replacement = if let Some(unit) = unit_value.as_deref() {
            apply_unit(value, unit)
        } else {
            value.to_string()
        };

        if !unit_leading.is_empty() {
            replacement = format!("{}{}", unit_leading, replacement);
        }

        let trailing = if has_unit {
            unit_trailing
        } else {
            token.trailing.clone()
        };
        let combined = format!("{}{}{}", token.leading, replacement, trailing);
        let consumed = if has_unit { 2 } else { 1 };
        Some((combined, consumed))
    }

    while idx < tokens.len() {
        if let Some((end_idx, value, word_count, has_multiplier, has_tens)) =
            parse_number_sequence(&tokens, idx)
        {
            let mut unit_value = None;
            let mut unit_trailing = String::new();
            let mut unit_leading = String::new();
            if end_idx < tokens.len() {
                let unit_core = tokens[end_idx].core_lower.as_str();
                if is_unit_word(unit_core) {
                    unit_value = Some(unit_core.to_string());
                    unit_trailing = tokens[end_idx].trailing.clone();
                    unit_leading = tokens[end_idx].leading.clone();
                }
            }

            let has_unit = unit_value.is_some();
            let combinable = has_multiplier || has_tens || word_count == 1;
            if !combinable {
                if let Some((combined, consumed)) = convert_single_token(&tokens, idx) {
                    out.push(combined);
                    idx += consumed;
                    continue;
                }
                let token = &tokens[idx];
                out.push(format!("{}{}{}", token.leading, token.core, token.trailing));
                idx += 1;
                continue;
            }
            let should_convert = has_unit || word_count > 1 || value >= 10;
            if should_convert {
                let mut replacement = if let Some(unit) = unit_value.as_deref() {
                    apply_unit(value, unit)
                } else {
                    value.to_string()
                };

                let leading = tokens[idx].leading.clone();
                let trailing = if has_unit {
                    unit_trailing
                } else {
                    tokens[end_idx.saturating_sub(1)].trailing.clone()
                };
                if !unit_leading.is_empty() {
                    replacement = format!("{}{}", unit_leading, replacement);
                }
                let combined = format!("{}{}{}", leading, replacement, trailing);
                out.push(combined);
                idx = end_idx + if unit_value.is_some() { 1 } else { 0 };
                continue;
            }
        }

        let token = &tokens[idx];
        out.push(format!("{}{}{}", token.leading, token.core, token.trailing));
        idx += 1;
    }

    out.join(" ")
}

#[derive(Debug)]
enum RepeatToken {
    Word(String),
    Whitespace(String),
    Other(String),
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum RepeatTokenKind {
    Word,
    Whitespace,
    Other,
}

fn is_repeat_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '\'' || ch == '-'
}

fn tokenize_for_repetition(input: &str) -> Vec<RepeatToken> {
    let mut tokens = Vec::new();
    let mut buffer = String::new();
    let mut current_kind: Option<RepeatTokenKind> = None;

    let mut flush = |kind: Option<RepeatTokenKind>, buffer: &mut String| {
        if buffer.is_empty() {
            return;
        }
        if let Some(kind) = kind {
            let text = std::mem::take(buffer);
            let token = match kind {
                RepeatTokenKind::Word => RepeatToken::Word(text),
                RepeatTokenKind::Whitespace => RepeatToken::Whitespace(text),
                RepeatTokenKind::Other => RepeatToken::Other(text),
            };
            tokens.push(token);
        }
    };

    for ch in input.chars() {
        let next_kind = if ch.is_whitespace() {
            RepeatTokenKind::Whitespace
        } else if is_repeat_word_char(ch) {
            RepeatTokenKind::Word
        } else {
            RepeatTokenKind::Other
        };

        if current_kind.is_some() && current_kind != Some(next_kind) {
            flush(current_kind, &mut buffer);
        }

        current_kind = Some(next_kind);
        buffer.push(ch);
    }

    flush(current_kind, &mut buffer);
    tokens
}

fn collapse_repeated_phrases(input: &str) -> String {
    let tokens = tokenize_for_repetition(input);
    if tokens.is_empty() {
        return String::new();
    }

    let mut keep = vec![true; tokens.len()];

    let mut run_positions: Vec<usize> = Vec::new();
    let mut run_words: Vec<String> = Vec::new();

    let flush_run =
        |run_positions: &mut Vec<usize>, run_words: &mut Vec<String>, keep: &mut Vec<bool>| {
            if run_positions.len() < 2 {
                run_positions.clear();
                run_words.clear();
                return;
            }

            let keep_indices = collapse_repeated_ngrams(run_words);
            let mut keep_word = vec![false; run_words.len()];
            for idx in keep_indices {
                if let Some(slot) = keep_word.get_mut(idx) {
                    *slot = true;
                }
            }

            for (rel_idx, token_idx) in run_positions.iter().enumerate() {
                if !keep_word[rel_idx] {
                    keep[*token_idx] = false;
                }
            }

            run_positions.clear();
            run_words.clear();
        };

    for (idx, token) in tokens.iter().enumerate() {
        match token {
            RepeatToken::Word(word) => {
                run_positions.push(idx);
                run_words.push(word.to_lowercase());
            }
            RepeatToken::Other(_) => {
                flush_run(&mut run_positions, &mut run_words, &mut keep);
            }
            RepeatToken::Whitespace(space) => {
                if space.contains('\n') {
                    flush_run(&mut run_positions, &mut run_words, &mut keep);
                }
            }
        }
    }
    flush_run(&mut run_positions, &mut run_words, &mut keep);

    let mut output = String::new();
    for (idx, token) in tokens.into_iter().enumerate() {
        if !keep[idx] {
            continue;
        }
        match token {
            RepeatToken::Word(text) | RepeatToken::Whitespace(text) | RepeatToken::Other(text) => {
                output.push_str(&text)
            }
        }
    }

    output
}

fn collapse_repeated_ngrams(words: &[String]) -> Vec<usize> {
    if words.len() < 2 {
        return (0..words.len()).collect();
    }

    let max_ngram = 4usize;
    let mut kept_indices = Vec::with_capacity(words.len());
    let mut idx = 0usize;

    while idx < words.len() {
        let mut collapsed = false;
        let max_len = ((words.len() - idx) / 2).min(max_ngram);
        for len in 1..=max_len {
            let end = idx + len;
            let repeat_end = idx + 2 * len;
            if words[idx..end] == words[end..repeat_end] {
                for keep_idx in idx..end {
                    kept_indices.push(keep_idx);
                }
                let mut cursor = end;
                while cursor + len <= words.len() && words[idx..end] == words[cursor..cursor + len]
                {
                    cursor += len;
                }
                idx = cursor;
                collapsed = true;
                break;
            }
        }

        if !collapsed {
            kept_indices.push(idx);
            idx += 1;
        }
    }

    kept_indices
}

pub fn deterministic_polish_with_options(
    input: &str,
    profile: AppProfile,
    remove_filler_words: bool,
) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut output = trimmed.to_string();

    output = collapse_repeated_phrases(&output);
    if profile != AppProfile::Terminal {
        output = apply_spoken_punctuation(&output);
    }
    if remove_filler_words
        && matches!(
            profile,
            AppProfile::Email | AppProfile::Docs | AppProfile::Chat | AppProfile::Default
        )
    {
        output = remove_fillers(&output);
    }

    output = convert_number_words(&output);
    output = normalize_whitespace(&output);
    output = fix_spacing_before_punct(&output);

    output.trim().to_string()
}

pub fn detect_spoken_command(input: &str) -> Option<SpokenCommand> {
    let trimmed = input.trim();
    if let Some(content) = parse_take_note_command(trimmed) {
        return Some(SpokenCommand::TakeNote { content });
    }

    let normalized = normalize_command_phrase(input);
    if normalized.is_empty() {
        return None;
    }

    if let Some(target) = normalized.strip_prefix("open ") {
        let target = target.trim();
        if !target.is_empty() {
            return Some(SpokenCommand::OpenApp {
                query: target.to_string(),
            });
        }
    }

    match normalized.as_str() {
        "scratch that" | "undo" | "undo that" | "delete that" | "delete last" | "remove that" => {
            Some(SpokenCommand::UndoLast)
        }
        "new line" | "newline" => Some(SpokenCommand::InsertNewLine),
        "new paragraph" => Some(SpokenCommand::InsertNewParagraph),
        "delete last sentence" | "remove last sentence" => Some(SpokenCommand::DeleteLastSentence),
        _ => None,
    }
}

fn parse_take_note_command(input: &str) -> Option<Option<String>> {
    if input.is_empty() {
        return None;
    }

    let lower = input.to_lowercase();
    let triggers = [
        "take note",
        "take a note",
        "take notes",
        "make a note",
        "make note",
    ];

    for trigger in triggers {
        if lower == trigger {
            return Some(None);
        }
        if lower.starts_with(trigger) {
            let remainder = input[trigger.len()..]
                .trim_start_matches(|c: char| {
                    c.is_whitespace() || matches!(c, ':' | '-' | '—' | ',')
                })
                .trim();
            if remainder.is_empty() {
                return Some(None);
            }
            return Some(Some(remainder.to_string()));
        }
    }

    None
}

pub fn protect_verbatim_spans(input: &str) -> (String, Vec<String>) {
    let (with_backticks, mut replacements) = protect_backticks(input);
    let (final_text, token_replacements) = protect_tokens(&with_backticks, replacements.len());
    replacements.extend(token_replacements);
    (final_text, replacements)
}

pub fn restore_verbatim_spans(input: &str, replacements: &[String]) -> String {
    let mut restored = input.to_string();
    for (idx, original) in replacements.iter().enumerate() {
        let placeholder = format!("<<V{}>>", idx);
        restored = restored.replace(&placeholder, original);
    }
    restored
}

pub fn validate_llm_output_with_reason(
    input: &str,
    output: &str,
    placeholders: &[String],
) -> Result<(), String> {
    let input_trimmed = input.trim();
    let output_trimmed = output.trim();
    if input_trimmed.is_empty() {
        if output_trimmed.is_empty() {
            return Err("output empty for empty input".to_string());
        }
        return Ok(());
    }
    if output_trimmed.is_empty() {
        return Err("output empty".to_string());
    }

    for idx in 0..placeholders.len() {
        let placeholder = format!("<<V{}>>", idx);
        if !output.contains(&placeholder) {
            return Err(format!("missing placeholder {}", placeholder));
        }
    }

    let input_len = input_trimmed.len();
    let output_len = output_trimmed.len();
    if input_len <= 20 {
        let max_len = input_len.saturating_mul(4).saturating_add(30);
        if output_len > max_len {
            return Err(format!(
                "output too long for short input (input_len={}, output_len={}, max_len={})",
                input_len, output_len, max_len
            ));
        }
    }
    if input_len > 20 {
        let max_len = (input_len as f32 * 1.35) as usize;
        if output_len > max_len {
            return Err(format!(
                "output too long (input_len={}, output_len={}, max_len={})",
                input_len, output_len, max_len
            ));
        }
    }
    if input_len > 40 && output_len < (input_len as f32 * 0.45) as usize {
        let min_len = (input_len as f32 * 0.45) as usize;
        return Err(format!(
            "output too short (input_len={}, output_len={}, min_len={})",
            input_len, output_len, min_len
        ));
    }

    let output_lower = output_trimmed.to_lowercase();
    if output_lower.contains("as an ai") || output_lower.contains("i can't") {
        return Err("output contains disallowed refusal text".to_string());
    }

    if input_len > 20 {
        let distance = levenshtein(input_trimmed, output_trimmed);
        let max_len = input_len.max(output_len) as f32;
        if max_len > 0.0 {
            let ratio = distance as f32 / max_len;
            if ratio > 0.6 {
                return Err(format!(
                    "output differs too much (distance_ratio={:.2})",
                    ratio
                ));
            }
        }
    }

    Ok(())
}

#[allow(dead_code)]
pub fn validate_llm_output(input: &str, output: &str, placeholders: &[String]) -> bool {
    validate_llm_output_with_reason(input, output, placeholders).is_ok()
}

pub fn build_prompt(
    template: &str,
    transcription: &str,
    context: Option<&FocusContext>,
    profile: AppProfile,
    glossary: &str,
    remove_filler_words: bool,
) -> String {
    let mut prompt = template.replace("${output}", transcription);
    let app_name = context
        .and_then(|ctx| ctx.app_name.as_ref())
        .map(String::as_str)
        .unwrap_or("");
    let app_identifier = context
        .and_then(|ctx| ctx.app_identifier.as_ref())
        .map(String::as_str)
        .unwrap_or("");
    let window_title = context
        .and_then(|ctx| ctx.window_title.as_ref())
        .map(String::as_str)
        .unwrap_or("");
    let browser_tab_title = context
        .and_then(|ctx| ctx.browser_tab_title.as_ref())
        .map(String::as_str)
        .unwrap_or("");
    let browser_tab_url = context
        .and_then(|ctx| ctx.browser_tab_url.as_ref())
        .map(String::as_str)
        .unwrap_or("");

    prompt = prompt.replace("${app_name}", app_name);
    prompt = prompt.replace("${app_identifier}", app_identifier);
    prompt = prompt.replace("${window_title}", window_title);
    prompt = prompt.replace("${app_profile}", profile.as_str());
    prompt = prompt.replace("${browser_tab_title}", browser_tab_title);
    prompt = prompt.replace("${browser_tab_url}", browser_tab_url);
    prompt = prompt.replace("${glossary}", glossary);
    prompt = prompt.replace(
        "${filler_cleanup_rule}",
        filler_cleanup_rule(remove_filler_words),
    );

    prompt
}

pub fn filler_cleanup_rule(remove_filler_words: bool) -> &'static str {
    if remove_filler_words {
        "Remove non-meaningful fillers and disfluencies: um, uh, ah, er, erm, hmm, you know, I mean, filler-only like/so/well, basically/actually when filler, repeated fragments, and abandoned false starts."
    } else {
        "Preserve spoken filler words such as um, uh, er, you know, and I mean when they appear in the transcript; do not delete them just for polish."
    }
}

fn apply_spoken_punctuation(input: &str) -> String {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    if tokens.is_empty() {
        return input.to_string();
    }

    let mut output = String::new();
    let mut i = 0;
    while i < tokens.len() {
        let word = tokens[i];
        let normalized = normalize_word(word);

        if i + 1 < tokens.len() {
            let next = tokens[i + 1];
            let phrase = format!("{} {}", normalized, normalize_word(next));
            match phrase.as_str() {
                "new line" => {
                    push_token(&mut output, "\n");
                    i += 2;
                    continue;
                }
                "new paragraph" => {
                    push_token(&mut output, "\n\n");
                    i += 2;
                    continue;
                }
                "question mark" => {
                    push_token(&mut output, "?");
                    i += 2;
                    continue;
                }
                "exclamation point" | "exclamation mark" => {
                    push_token(&mut output, "!");
                    i += 2;
                    continue;
                }
                "full stop" => {
                    push_token(&mut output, ".");
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }

        match normalized.as_str() {
            "comma" => push_token(&mut output, ","),
            "period" => push_token(&mut output, "."),
            "question" if i + 1 < tokens.len() && normalize_word(tokens[i + 1]) == "mark" => {
                push_token(&mut output, "?");
                i += 1;
            }
            "semicolon" => push_token(&mut output, ";"),
            "colon" => push_token(&mut output, ":"),
            "ellipsis" => push_token(&mut output, "..."),
            _ => push_token(&mut output, word),
        }

        i += 1;
    }

    output
}

fn remove_fillers(input: &str) -> String {
    let fillers = ["um", "uh", "erm", "er", "ah", "hmm", "mm", "uhh", "umm"];
    let mut output = String::new();
    for word in input.split_whitespace() {
        let normalized = normalize_word(word);
        if fillers.contains(&normalized.as_str()) {
            continue;
        }
        push_token(&mut output, word);
    }
    output
}

fn normalize_word(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_alphabetic())
        .to_lowercase()
}

fn normalize_whitespace(input: &str) -> String {
    let mut output = String::new();
    let mut last_was_space = false;
    for ch in input.chars() {
        if ch == '\n' {
            if output.ends_with(' ') {
                output.pop();
            }
            output.push('\n');
            last_was_space = false;
        } else if ch.is_whitespace() {
            if !last_was_space {
                output.push(' ');
                last_was_space = true;
            }
        } else {
            output.push(ch);
            last_was_space = false;
        }
    }
    output
}

fn normalize_command_phrase(input: &str) -> String {
    let mut output = String::new();
    let mut last_was_space = false;
    for ch in input.chars() {
        if ch.is_alphanumeric() {
            output.push(ch.to_ascii_lowercase());
            last_was_space = false;
        } else if ch.is_whitespace() {
            if !last_was_space {
                output.push(' ');
                last_was_space = true;
            }
        }
    }
    output.trim().to_string()
}

fn override_for_context(
    context: &FocusContext,
    overrides: &std::collections::HashMap<String, String>,
) -> Option<AppProfile> {
    if overrides.is_empty() {
        return None;
    }

    let app_id = context
        .app_identifier
        .as_ref()
        .map(|value| value.to_lowercase());
    let app_name = context.app_name.as_ref().map(|value| value.to_lowercase());
    let window_title = context
        .window_title
        .as_ref()
        .map(|value| value.to_lowercase());

    for (key, value) in overrides {
        let key_lower = key.to_lowercase();
        let matched = app_id.as_ref().map_or(false, |id| id == &key_lower)
            || app_name.as_ref().map_or(false, |name| name == &key_lower)
            || window_title
                .as_ref()
                .map_or(false, |title| title.contains(&key_lower));
        if matched {
            return AppProfile::from_str(value);
        }
    }

    None
}

fn fix_spacing_before_punct(input: &str) -> String {
    let mut output = input.to_string();
    for punct in [",", ".", "?", "!", ":", ";"] {
        let pattern = format!(" {}", punct);
        output = output.replace(&pattern, punct);
    }
    output
}

fn push_token(output: &mut String, token: &str) {
    if token == "\n" || token == "\n\n" {
        while output.ends_with(' ') {
            output.pop();
        }
        output.push_str(token);
        return;
    }

    if output.is_empty() {
        output.push_str(token);
        return;
    }

    if is_punct_token(token) {
        output.push_str(token);
        return;
    }

    if output.ends_with('\n') {
        output.push_str(token);
    } else {
        output.push(' ');
        output.push_str(token);
    }
}

fn is_punct_token(token: &str) -> bool {
    matches!(token, "," | "." | "?" | "!" | ":" | ";" | "...")
}

fn protect_backticks(input: &str) -> (String, Vec<String>) {
    let mut output = String::new();
    let mut replacements = Vec::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '`' {
            output.push(ch);
            continue;
        }

        let mut span = String::new();
        span.push(ch);
        let mut found_end = false;
        while let Some(next) = chars.next() {
            span.push(next);
            if next == '`' {
                found_end = true;
                break;
            }
        }

        if found_end {
            let placeholder = format!("<<V{}>>", replacements.len());
            replacements.push(span);
            output.push_str(&placeholder);
        } else {
            output.push_str(&span);
        }
    }

    (output, replacements)
}

fn protect_tokens(input: &str, start_index: usize) -> (String, Vec<String>) {
    let mut output = String::new();
    let mut replacements = Vec::new();
    let mut index = start_index;

    for token in input.split_whitespace() {
        if should_protect_token(token) {
            let placeholder = format!("<<V{}>>", index);
            replacements.push(token.to_string());
            index += 1;
            push_token(&mut output, &placeholder);
        } else {
            push_token(&mut output, token);
        }
    }

    (output, replacements)
}

fn should_protect_token(token: &str) -> bool {
    let trimmed = token.trim_matches(|c: char| c.is_whitespace());
    if trimmed.len() < 3 {
        return false;
    }

    if is_verbatim_placeholder(trimmed) {
        return false;
    }

    if trimmed.contains("://") || trimmed.contains("www.") {
        return true;
    }
    if trimmed.contains('@') && trimmed.contains('.') {
        return true;
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return true;
    }
    if trimmed.contains('_') || trimmed.contains("::") || trimmed.contains('#') {
        return true;
    }
    if has_mixed_case(trimmed) || has_letter_digit_mix(trimmed) {
        return true;
    }
    if has_file_extension(trimmed) {
        return true;
    }

    false
}

fn is_verbatim_placeholder(token: &str) -> bool {
    token
        .strip_prefix("<<V")
        .and_then(|rest| rest.strip_suffix(">>"))
        .is_some_and(|index| !index.is_empty() && index.chars().all(|c| c.is_ascii_digit()))
}

fn has_mixed_case(token: &str) -> bool {
    let mut has_lower = false;
    let mut has_upper = false;
    for ch in token.chars() {
        if ch.is_lowercase() {
            has_lower = true;
        } else if ch.is_uppercase() {
            has_upper = true;
        }
        if has_lower && has_upper {
            return true;
        }
    }
    false
}

fn has_letter_digit_mix(token: &str) -> bool {
    let mut has_alpha = false;
    let mut has_digit = false;
    for ch in token.chars() {
        if ch.is_ascii_alphabetic() {
            has_alpha = true;
        } else if ch.is_ascii_digit() {
            has_digit = true;
        }
        if has_alpha && has_digit {
            return true;
        }
    }
    false
}

fn has_file_extension(token: &str) -> bool {
    if let Some(dot) = token.rfind('.') {
        let (prefix, ext) = token.split_at(dot + 1);
        if prefix.len() > 1 && !ext.is_empty() && ext.len() <= 6 {
            return ext.chars().all(|c| c.is_ascii_alphanumeric());
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::focus_context::FocusContext;

    #[test]
    fn build_prompt_replaces_transcript_context_profile_and_glossary() {
        let context = FocusContext {
            app_name: Some("Codex".to_string()),
            app_identifier: Some("com.openai.codex".to_string()),
            window_title: Some("BreezeType".to_string()),
            process_id: Some(42),
            browser_tab_title: Some("Prompt Review".to_string()),
            browser_tab_url: Some("https://example.com/review".to_string()),
        };
        let template = "App=${app_name}; Id=${app_identifier}; Profile=${app_profile}; Window=${window_title}; Tab=${browser_tab_title}; URL=${browser_tab_url}; Glossary=${glossary}; Transcript=${output}";

        let prompt = build_prompt(
            template,
            "hello <<V0>>",
            Some(&context),
            AppProfile::CodeComment,
            "Vercel",
            true,
        );

        assert!(prompt.contains("App=Codex"));
        assert!(prompt.contains("Id=com.openai.codex"));
        assert!(prompt.contains("Profile=code_comment"));
        assert!(prompt.contains("Window=BreezeType"));
        assert!(prompt.contains("Tab=Prompt Review"));
        assert!(prompt.contains("URL=https://example.com/review"));
        assert!(prompt.contains("Glossary=Vercel"));
        assert!(prompt.contains("Transcript=hello <<V0>>"));
    }

    #[test]
    fn build_prompt_replaces_filler_cleanup_rule() {
        let template = "Rule=${filler_cleanup_rule}; Transcript=${output}";

        let enabled_prompt =
            build_prompt(template, "um hello", None, AppProfile::Default, "", true);
        let disabled_prompt =
            build_prompt(template, "um hello", None, AppProfile::Default, "", false);

        assert!(enabled_prompt.contains("Remove non-meaningful fillers"));
        assert!(disabled_prompt.contains("Preserve spoken filler words"));
        assert!(!enabled_prompt.contains("${filler_cleanup_rule}"));
        assert!(!disabled_prompt.contains("${filler_cleanup_rule}"));
    }

    #[test]
    fn deterministic_polish_can_preserve_fillers() {
        assert_eq!(
            deterministic_polish_with_options("um hello", AppProfile::Default, true),
            "hello"
        );
        assert_eq!(
            deterministic_polish_with_options("um hello", AppProfile::Default, false),
            "um hello"
        );
    }

    #[test]
    fn protected_placeholders_must_survive_validation_and_restore() {
        let input = "run `bun test` at https://example.com/path";
        let (protected, replacements) = protect_verbatim_spans(input);

        assert!(protected.contains("<<V0>>"));
        assert!(protected.contains("<<V1>>"));
        assert_eq!(replacements.len(), 2);
        assert!(validate_llm_output_with_reason(&protected, &protected, &replacements).is_ok());

        let missing_first_placeholder = protected.replace("<<V0>>", "bun test");
        let err =
            validate_llm_output_with_reason(&protected, &missing_first_placeholder, &replacements)
                .expect_err("missing protected placeholder should fail validation");
        assert!(err.contains("missing placeholder <<V0>>"));

        assert_eq!(restore_verbatim_spans(&protected, &replacements), input);
    }
}
