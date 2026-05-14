use crate::focus_context::FocusContext;
use crate::input::{self, EnigoState};
use crate::settings::PasteMethod;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug)]
pub struct PasteTransaction {
    pub inserted_text: String,
    #[allow(dead_code)]
    pub paste_method: PasteMethod,
    #[allow(dead_code)]
    pub timestamp_ms: u64,
    #[allow(dead_code)]
    pub focus_context: Option<FocusContext>,
}

pub struct InsertionManager {
    stack: Mutex<Vec<PasteTransaction>>,
    max_depth: usize,
}

impl InsertionManager {
    pub fn new() -> Self {
        Self {
            stack: Mutex::new(Vec::new()),
            max_depth: 20,
        }
    }

    pub fn record(&self, transaction: PasteTransaction) {
        if let Ok(mut stack) = self.stack.lock() {
            stack.push(transaction);
            if stack.len() > self.max_depth {
                let overflow = stack.len() - self.max_depth;
                stack.drain(0..overflow);
            }
        }
    }

    pub fn undo_last(&self, app_handle: &AppHandle) -> Result<(), String> {
        let transaction = {
            let mut stack = self
                .stack
                .lock()
                .map_err(|_| "Failed to lock insertion history".to_string())?;
            stack.pop()
        };

        let Some(transaction) = transaction else {
            return Err("No insertion history available".into());
        };

        let count = transaction.inserted_text.chars().count();
        if count == 0 {
            return Ok(());
        }

        let enigo_state = app_handle
            .try_state::<EnigoState>()
            .ok_or_else(|| "Enigo state not available".to_string())?;
        let mut enigo_guard = enigo_state
            .0
            .lock()
            .map_err(|_| "Failed to lock Enigo state".to_string())?;
        if enigo_guard.is_none() {
            *enigo_guard = Some(input::create_enigo()?);
        }
        let enigo = enigo_guard
            .as_mut()
            .ok_or_else(|| "Failed to initialize Enigo".to_string())?;

        input::send_backspace(enigo, count)?;
        Ok(())
    }

    pub fn delete_last_sentence(&self, app_handle: &AppHandle) -> Result<(), String> {
        let transaction = {
            let mut stack = self
                .stack
                .lock()
                .map_err(|_| "Failed to lock insertion history".to_string())?;
            stack.pop()
        };

        let Some(mut transaction) = transaction else {
            return Err("No insertion history available".into());
        };

        let chars: Vec<char> = transaction.inserted_text.chars().collect();
        if chars.is_empty() {
            return Ok(());
        }

        let delete_start = find_last_sentence_start(&chars);
        let delete_count = chars.len().saturating_sub(delete_start);
        if delete_count == 0 {
            return Ok(());
        }

        let enigo_state = app_handle
            .try_state::<EnigoState>()
            .ok_or_else(|| "Enigo state not available".to_string())?;
        let mut enigo_guard = enigo_state
            .0
            .lock()
            .map_err(|_| "Failed to lock Enigo state".to_string())?;
        if enigo_guard.is_none() {
            *enigo_guard = Some(input::create_enigo()?);
        }
        let enigo = enigo_guard
            .as_mut()
            .ok_or_else(|| "Failed to initialize Enigo".to_string())?;

        input::send_backspace(enigo, delete_count)?;

        let remaining: String = chars[..delete_start].iter().collect();
        transaction.inserted_text = remaining;
        if !transaction.inserted_text.is_empty() {
            if let Ok(mut stack) = self.stack.lock() {
                stack.push(transaction);
            }
        }

        Ok(())
    }
}

pub fn make_transaction(
    inserted_text: String,
    paste_method: PasteMethod,
    focus_context: Option<FocusContext>,
) -> PasteTransaction {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    PasteTransaction {
        inserted_text,
        paste_method,
        timestamp_ms,
        focus_context,
    }
}

fn find_last_sentence_start(chars: &[char]) -> usize {
    let mut trim_end = chars.len();
    while trim_end > 0 && chars[trim_end - 1].is_whitespace() {
        trim_end -= 1;
    }

    let mut boundaries = Vec::new();
    for i in 0..trim_end {
        if matches!(chars[i], '.' | '!' | '?' | '\n') {
            boundaries.push(i);
        }
    }

    if boundaries.is_empty() {
        return 0;
    }

    let last = *boundaries.last().unwrap();
    if last + 1 == trim_end {
        if boundaries.len() >= 2 {
            return boundaries[boundaries.len() - 2] + 1;
        }
        return 0;
    }

    last + 1
}
