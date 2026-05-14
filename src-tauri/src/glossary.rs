use crate::audio_toolkit::apply_custom_words;
use crate::focus_context::FocusContext;
use crate::settings::AppSettings;

#[derive(Clone, Debug)]
pub struct GlossaryTerm {
    pub canonical: String,
    pub variants: Vec<Vec<String>>,
}

#[derive(Clone, Debug, Default)]
pub struct GlossaryData {
    pub terms: Vec<GlossaryTerm>,
    pub canonical_terms: Vec<String>,
    pub single_terms: Vec<String>,
}

impl GlossaryData {
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }
}

pub fn build_glossary(
    settings: &AppSettings,
    context: Option<&FocusContext>,
    input: &str,
) -> GlossaryData {
    let mut canonical_terms: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for entry in &settings.custom_dictionary {
        let term = entry.term.trim();
        if term.is_empty() {
            continue;
        }
        let key = term.to_lowercase();
        if seen.insert(key) {
            canonical_terms.push(term.to_string());
        }
    }

    if should_include_aws_terms(context, input) {
        for term in aws_glossary_terms() {
            let key = term.to_lowercase();
            if seen.insert(key) {
                canonical_terms.push(term.to_string());
            }
        }
    }

    let mut terms = Vec::new();
    let mut single_terms = Vec::new();

    for canonical in &canonical_terms {
        let mut term = GlossaryTerm::new(canonical);
        apply_builtin_variants(&mut term);
        if canonical.split_whitespace().count() == 1 {
            single_terms.push(canonical.clone());
        }
        terms.push(term);
    }

    GlossaryData {
        terms,
        canonical_terms,
        single_terms,
    }
}

pub fn apply_glossary(input: &str, data: &GlossaryData, threshold: f64) -> String {
    if data.is_empty() {
        return input.to_string();
    }

    let mut text = apply_phrase_replacements(input, &data.terms);

    if !data.single_terms.is_empty() {
        text = apply_custom_words(&text, &data.single_terms, threshold);
    }

    text
}

pub fn format_glossary_block(data: &GlossaryData, max_terms: usize) -> String {
    if data.canonical_terms.is_empty() {
        return String::new();
    }

    let trimmed = if max_terms == 0 || data.canonical_terms.len() <= max_terms {
        data.canonical_terms.clone()
    } else {
        data.canonical_terms
            .iter()
            .cloned()
            .take(max_terms)
            .collect()
    };

    format!(
        "Glossary (preserve exact casing; replace near-matches with these forms):\n{}",
        trimmed.join(", ")
    )
}

impl GlossaryTerm {
    pub fn new(canonical: &str) -> Self {
        let mut term = Self {
            canonical: canonical.to_string(),
            variants: Vec::new(),
        };
        term.add_variant(split_into_tokens(canonical));

        if is_acronym(canonical) {
            term.add_variant(spell_out_acronym(canonical));
        }

        let phrase_variant = expand_phrase_acronyms(canonical);
        if !phrase_variant.is_empty() {
            term.add_variant(phrase_variant);
        }

        term
    }

    pub fn add_variant(&mut self, variant: Vec<String>) {
        if variant.is_empty() {
            return;
        }
        if !self.variants.iter().any(|existing| existing == &variant) {
            self.variants.push(variant);
        }
    }
}

#[derive(Clone, Debug)]
struct Token {
    raw: String,
    clean: String,
    prefix: String,
    suffix: String,
}

fn apply_phrase_replacements(input: &str, terms: &[GlossaryTerm]) -> String {
    let tokens = tokenize(input);
    if tokens.is_empty() || terms.is_empty() {
        return input.to_string();
    }

    let mut output: Vec<String> = Vec::with_capacity(tokens.len());
    let mut idx = 0;

    while idx < tokens.len() {
        let mut best_match: Option<(&GlossaryTerm, &Vec<String>)> = None;
        let mut best_len = 0usize;

        for term in terms {
            for variant in &term.variants {
                let len = variant.len();
                if len == 0 || idx + len > tokens.len() {
                    continue;
                }
                if len < best_len {
                    continue;
                }
                if match_variant(&tokens, idx, variant) {
                    if len > best_len {
                        best_match = Some((term, variant));
                        best_len = len;
                    }
                }
            }
        }

        if let Some((term, variant)) = best_match {
            let first = &tokens[idx];
            let last = &tokens[idx + variant.len() - 1];
            let prefix = first.prefix.clone();
            let suffix = last.suffix.clone();
            let replacement_tokens: Vec<&str> = term.canonical.split_whitespace().collect();
            for (i, rep) in replacement_tokens.iter().enumerate() {
                let mut token = rep.to_string();
                if i == 0 {
                    token = format!("{}{}", prefix, token);
                }
                if i == replacement_tokens.len().saturating_sub(1) {
                    token = format!("{}{}", token, suffix);
                }
                output.push(token);
            }
            idx += variant.len();
            continue;
        }

        output.push(tokens[idx].raw.clone());
        idx += 1;
    }

    join_tokens(output)
}

fn match_variant(tokens: &[Token], start: usize, variant: &[String]) -> bool {
    for (offset, needle) in variant.iter().enumerate() {
        let token = &tokens[start + offset];
        if token.clean.is_empty() || token.clean != *needle {
            return false;
        }
    }
    true
}

fn tokenize(input: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in input.chars() {
        if ch == '\n' {
            if !current.is_empty() {
                tokens.push(split_token(&current));
                current.clear();
            }
            tokens.push(Token {
                raw: "\n".to_string(),
                clean: String::new(),
                prefix: String::new(),
                suffix: String::new(),
            });
        } else if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(split_token(&current));
                current.clear();
            }
        } else {
            current.push(ch);
        }
    }

    if !current.is_empty() {
        tokens.push(split_token(&current));
    }

    tokens
}

fn join_tokens(tokens: Vec<String>) -> String {
    let mut output = String::new();
    for token in tokens {
        if token == "\n" {
            while output.ends_with(' ') {
                output.pop();
            }
            output.push('\n');
            continue;
        }

        if output.is_empty() {
            output.push_str(&token);
            continue;
        }

        if is_punct_token(&token) {
            output.push_str(&token);
            continue;
        }

        if output.ends_with('\n') {
            output.push_str(&token);
        } else {
            output.push(' ');
            output.push_str(&token);
        }
    }
    output
}

fn is_punct_token(token: &str) -> bool {
    matches!(token, "," | "." | "?" | "!" | ":" | ";" | "...")
}

fn split_token(raw: &str) -> Token {
    let mut start = None;
    let mut end = None;

    for (idx, ch) in raw.char_indices() {
        if ch.is_ascii_alphanumeric() {
            start = Some(idx);
            break;
        }
    }

    for (idx, ch) in raw.char_indices().rev() {
        if ch.is_ascii_alphanumeric() {
            end = Some(idx + ch.len_utf8());
            break;
        }
    }

    match (start, end) {
        (Some(start), Some(end)) if start < end => {
            let prefix = raw[..start].to_string();
            let suffix = raw[end..].to_string();
            let core = &raw[start..end];
            let clean = core
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_lowercase();
            Token {
                raw: raw.to_string(),
                clean,
                prefix,
                suffix,
            }
        }
        _ => Token {
            raw: raw.to_string(),
            clean: String::new(),
            prefix: raw.to_string(),
            suffix: String::new(),
        },
    }
}

fn split_into_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut prev_is_lower = false;
    let mut prev_is_alpha = false;
    let mut prev_is_digit = false;

    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            let is_upper = ch.is_uppercase();
            let is_lower = ch.is_lowercase();
            let is_digit = ch.is_ascii_digit();

            let boundary = !current.is_empty()
                && ((prev_is_alpha && is_digit)
                    || (prev_is_digit && ch.is_ascii_alphabetic())
                    || (prev_is_lower && is_upper));

            if boundary {
                tokens.push(current);
                current = String::new();
            }

            current.push(ch);
            prev_is_lower = is_lower;
            prev_is_alpha = ch.is_ascii_alphabetic();
            prev_is_digit = is_digit;
        } else {
            if !current.is_empty() {
                tokens.push(current);
                current = String::new();
            }
            prev_is_lower = false;
            prev_is_alpha = false;
            prev_is_digit = false;
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
        .into_iter()
        .map(|token| token.to_lowercase())
        .collect()
}

fn is_acronym(input: &str) -> bool {
    let trimmed = input.trim();
    if trimmed.len() < 2 || trimmed.len() > 6 {
        return false;
    }
    let mut has_alpha = false;
    for ch in trimmed.chars() {
        if ch.is_ascii_alphabetic() {
            has_alpha = true;
            if !ch.is_uppercase() {
                return false;
            }
        } else if !ch.is_ascii_digit() {
            return false;
        }
    }
    has_alpha
}

fn spell_out_acronym(input: &str) -> Vec<String> {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase().to_string())
        .collect()
}

fn expand_phrase_acronyms(input: &str) -> Vec<String> {
    let parts: Vec<&str> = input.split_whitespace().collect();
    if parts.len() < 2 {
        return Vec::new();
    }

    let mut expanded = Vec::new();
    let mut used = false;

    for part in parts {
        if is_acronym(part) {
            used = true;
            expanded.extend(spell_out_acronym(part));
        } else {
            expanded.extend(split_into_tokens(part));
        }
    }

    if used {
        expanded
    } else {
        Vec::new()
    }
}

fn apply_builtin_variants(term: &mut GlossaryTerm) {
    if term.canonical.eq_ignore_ascii_case("AWS CLI") {
        term.add_variant(vec![
            "aws".to_string(),
            "c".to_string(),
            "l".to_string(),
            "i".to_string(),
        ]);
    }

    if term.canonical.eq_ignore_ascii_case("Elastic Beanstalk") {
        term.add_variant(vec!["elastic".to_string(), "meanstalk".to_string()]);
    }

    if term.canonical.eq_ignore_ascii_case("Route 53") {
        term.add_variant(vec![
            "route".to_string(),
            "fifty".to_string(),
            "three".to_string(),
        ]);
    }

    if term.canonical.eq_ignore_ascii_case("S3") {
        term.add_variant(vec!["s".to_string(), "3".to_string()]);
        term.add_variant(vec!["s".to_string(), "three".to_string()]);
    }

    if term.canonical.eq_ignore_ascii_case("EC2") {
        term.add_variant(vec!["e".to_string(), "c".to_string(), "2".to_string()]);
        term.add_variant(vec!["e".to_string(), "c".to_string(), "two".to_string()]);
    }
}

fn aws_glossary_terms() -> Vec<&'static str> {
    vec![
        "AWS",
        "AWS CLI",
        "CloudWatch",
        "CloudTrail",
        "CloudFront",
        "CloudFormation",
        "Elastic Beanstalk",
        "Lambda",
        "DynamoDB",
        "S3",
        "EC2",
        "ECS",
        "EKS",
        "ECR",
        "RDS",
        "Aurora",
        "Route 53",
        "IAM",
        "VPC",
        "SQS",
        "SNS",
        "Kinesis",
        "Redshift",
        "EventBridge",
        "Step Functions",
        "API Gateway",
        "OpenSearch",
        "Fargate",
    ]
}

fn should_include_aws_terms(context: Option<&FocusContext>, input: &str) -> bool {
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
            haystack.push(' ');
        }
        if let Some(tab) = &ctx.browser_tab_title {
            haystack.push_str(tab);
            haystack.push(' ');
        }
        if let Some(url) = &ctx.browser_tab_url {
            haystack.push_str(url);
            haystack.push(' ');
        }
    }
    haystack.push_str(input);

    let haystack_lower = haystack.to_lowercase();
    if haystack_lower.contains("aws.amazon") || haystack_lower.contains("console.aws") {
        return true;
    }
    if haystack_lower.contains("cloud watch")
        || haystack_lower.contains("cloud trail")
        || haystack_lower.contains("cloud front")
        || haystack_lower.contains("cloud formation")
        || haystack_lower.contains("elastic meanstalk")
        || haystack_lower.contains("aws c l i")
    {
        return true;
    }

    let tokens = split_into_tokens(&haystack_lower);
    tokens
        .iter()
        .any(|token| token == "aws" || token == "amazon")
        || tokens.iter().any(|token| {
            matches!(
                token.as_str(),
                "cloudwatch"
                    | "cloudtrail"
                    | "cloudfront"
                    | "cloudformation"
                    | "lambda"
                    | "dynamodb"
                    | "s3"
                    | "ec2"
                    | "ecs"
                    | "eks"
                    | "ecr"
                    | "rds"
                    | "aurora"
                    | "route53"
                    | "iam"
                    | "vpc"
                    | "sqs"
                    | "sns"
                    | "kinesis"
                    | "redshift"
                    | "eventbridge"
                    | "step"
                    | "functions"
                    | "apigateway"
                    | "opensearch"
                    | "fargate"
                    | "beanstalk"
            )
        })
}
