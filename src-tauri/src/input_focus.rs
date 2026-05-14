#[cfg(target_os = "macos")]
use core_foundation::base::{CFType, CFTypeRef, TCFType};
#[cfg(target_os = "macos")]
use core_foundation::boolean::CFBoolean;
#[cfg(target_os = "macos")]
use core_foundation::string::{CFString, CFStringRef};
#[cfg(target_os = "macos")]
use std::ffi::c_void;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusDetectionState {
    TextInput,
    NotTextInput,
    Unavailable,
}

#[cfg(target_os = "macos")]
type AXUIElementRef = *const c_void;
#[cfg(target_os = "macos")]
type AXError = i32;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
}

#[cfg(target_os = "macos")]
fn ax_copy_attribute_value(element: AXUIElementRef, attribute: &'static str) -> Option<CFType> {
    let attr = CFString::from_static_string(attribute);
    let mut value: CFTypeRef = std::ptr::null_mut();
    let result =
        unsafe { AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value) };
    if result != 0 || value.is_null() {
        return None;
    }
    Some(unsafe { CFType::wrap_under_create_rule(value) })
}

#[cfg(target_os = "macos")]
fn current_focused_element() -> Option<CFType> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        return None;
    }

    ax_copy_attribute_value(system, "AXFocusedUIElement")
}

#[cfg(target_os = "macos")]
fn element_ref(element: &CFType) -> AXUIElementRef {
    element.as_CFTypeRef() as AXUIElementRef
}

#[cfg(target_os = "macos")]
fn ax_bool_attribute(element: AXUIElementRef, attribute: &'static str) -> Option<bool> {
    let value = ax_copy_attribute_value(element, attribute)?;
    let cf_bool = value.downcast::<CFBoolean>()?;
    Some(cf_bool == CFBoolean::true_value())
}

#[cfg(target_os = "macos")]
fn ax_string_attribute(element: AXUIElementRef, attribute: &'static str) -> Option<String> {
    let value = ax_copy_attribute_value(element, attribute)?;
    let cf_string = value.downcast::<CFString>()?;
    Some(cf_string.to_string())
}

#[cfg(target_os = "macos")]
fn element_is_text_input(element: AXUIElementRef) -> bool {
    if matches!(ax_bool_attribute(element, "AXEditable"), Some(true)) {
        return true;
    }

    if let Some(subrole) = ax_string_attribute(element, "AXSubrole") {
        if subrole == "AXContentEditable" || subrole == "AXTextInput" {
            return true;
        }
    }

    if let Some(role) = ax_string_attribute(element, "AXRole") {
        return matches!(
            role.as_str(),
            "AXTextField"
                | "AXTextArea"
                | "AXSearchField"
                | "AXComboBox"
                | "AXComboBoxField"
                | "AXSecureTextField"
                | "AXTextView"
                | "AXTokenField"
        );
    }

    false
}

#[cfg(target_os = "macos")]
fn ax_element_pid(element: AXUIElementRef) -> Option<i32> {
    let mut pid: i32 = 0;
    let result = unsafe { AXUIElementGetPid(element, &mut pid) };
    if result != 0 {
        return None;
    }
    Some(pid)
}

#[cfg(target_os = "macos")]
pub fn focused_text_input_state_for_process(target_process_id: Option<i64>) -> FocusDetectionState {
    let focused_element = match current_focused_element() {
        Some(element) => element,
        None => return FocusDetectionState::Unavailable,
    };
    let focused_element_ref = element_ref(&focused_element);

    if let Some(target_pid) = target_process_id {
        match ax_element_pid(focused_element_ref) {
            Some(pid) if i64::from(pid) == target_pid => {}
            Some(_) => return FocusDetectionState::NotTextInput,
            None => return FocusDetectionState::Unavailable,
        }
    }

    if element_is_text_input(focused_element_ref) {
        FocusDetectionState::TextInput
    } else {
        FocusDetectionState::NotTextInput
    }
}

#[cfg(not(target_os = "macos"))]
pub fn focused_text_input_state_for_process(
    _target_process_id: Option<i64>,
) -> FocusDetectionState {
    FocusDetectionState::TextInput
}
