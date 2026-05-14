use base64::engine::general_purpose::STANDARD;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;

static ICON_DATA_URL_CACHE: Lazy<Mutex<HashMap<String, Option<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn get_app_icon_data_url(identifier: &str) -> Option<String> {
    let normalized = identifier.trim();
    if normalized.is_empty() {
        return None;
    }

    if let Ok(cache) = ICON_DATA_URL_CACHE.lock() {
        if let Some(cached) = cache.get(normalized) {
            return cached.clone();
        }
    }

    #[cfg(target_os = "macos")]
    let resolved = macos::get_app_icon_data_url(normalized);

    #[cfg(not(target_os = "macos"))]
    let resolved = {
        let _ = normalized;
        None
    };

    if let Ok(mut cache) = ICON_DATA_URL_CACHE.lock() {
        cache.insert(normalized.to_string(), resolved.clone());
    }

    resolved
}

#[cfg(target_os = "macos")]
mod macos {
    use super::STANDARD;
    use base64::Engine as _;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSWorkspace};
    use objc2_foundation::{NSCopying, NSData, NSDictionary, NSString};
    use std::ffi::c_void;
    use std::ptr::NonNull;

    pub fn get_app_icon_data_url(identifier: &str) -> Option<String> {
        let png_bytes = get_icon_png_bytes(identifier)?;
        Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(png_bytes)
        ))
    }

    fn get_icon_png_bytes(identifier: &str) -> Option<Vec<u8>> {
        autoreleasepool(|_pool| {
            let workspace = NSWorkspace::sharedWorkspace();
            let icon = if identifier.contains('/') || identifier.ends_with(".app") {
                let path = NSString::from_str(identifier);
                workspace.iconForFile(&path)
            } else {
                let bundle_id = NSString::from_str(identifier);
                let url = workspace.URLForApplicationWithBundleIdentifier(&bundle_id)?;
                let path = url.path()?;
                workspace.iconForFile(&path)
            };

            nsimage_to_png_bytes(&icon)
        })
    }

    fn nsimage_to_png_bytes(image: &NSImage) -> Option<Vec<u8>> {
        let tiff = image.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;

        let props = empty_dict::<objc2_app_kit::NSBitmapImageRepPropertyKey>();
        let data =
            unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props)? };

        data_to_vec(&data)
    }

    fn data_to_vec(data: &NSData) -> Option<Vec<u8>> {
        let length = data.length() as usize;
        if length == 0 {
            return None;
        }
        let mut buffer = vec![0u8; length];
        unsafe {
            let ptr = NonNull::new(buffer.as_mut_ptr() as *mut c_void)?;
            data.getBytes_length(ptr, length as _);
        }
        Some(buffer)
    }

    fn empty_dict<K: objc2::Message>() -> objc2::rc::Retained<NSDictionary<K, AnyObject>> {
        let objects: *mut NonNull<AnyObject> = std::ptr::null_mut();
        let keys: *mut NonNull<ProtocolObject<dyn NSCopying>> = std::ptr::null_mut();
        unsafe { NSDictionary::dictionaryWithObjects_forKeys_count(objects, keys, 0) }
    }
}
