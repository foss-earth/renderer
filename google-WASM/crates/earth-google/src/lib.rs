//! Google-profile geometry byte processing. JSON profile selection and JPEG
//! decode stay in the owning worker. This core validates the GLB envelope and
//! expands bounded interleaved accessors without trusting caller pointers.
use std::cell::RefCell;

const LIMIT: usize = 128 * 1024 * 1024;
const MAX_BUFFERS: usize = 64;
const MAX_ELEMENTS: usize = 4_194_304;
const INVALID: u32 = 1;
const BOUNDS: u32 = 2;
const PROFILE: u32 = 3;

enum Buffer {
    Bytes(Vec<u8>),
    Words(Vec<u32>),
}
impl Buffer {
    fn pointer(&self) -> usize {
        match self {
            Self::Bytes(v) => v.as_ptr() as usize,
            Self::Words(v) => v.as_ptr() as usize,
        }
    }
    fn len(&self) -> usize {
        match self {
            Self::Bytes(v) => v.len(),
            Self::Words(v) => v.len(),
        }
    }
    fn kind(&self) -> u32 {
        match self {
            Self::Bytes(_) => 0,
            Self::Words(_) => 1,
        }
    }
    fn bytes(&self) -> usize {
        self.len() * if self.kind() == 0 { 1 } else { 4 }
    }
}
#[derive(Default)]
struct Registry {
    buffers: Vec<Buffer>,
    bytes: usize,
}
impl Registry {
    fn alloc(&mut self, kind: u32, len: u32) -> usize {
        let len = len as usize;
        let Some(bytes) = len.checked_mul(if kind == 0 { 1 } else { 4 }) else {
            return 0;
        };
        if kind > 1
            || len == 0
            || bytes > LIMIT.saturating_sub(self.bytes)
            || self.buffers.len() >= MAX_BUFFERS
            || self.buffers.try_reserve(1).is_err()
        {
            return 0;
        }
        let buffer = if kind == 0 {
            let mut values = Vec::new();
            if values.try_reserve_exact(len).is_err() {
                return 0;
            }
            values.resize(len, 0);
            Buffer::Bytes(values)
        } else {
            let mut values = Vec::new();
            if values.try_reserve_exact(len).is_err() {
                return 0;
            }
            values.resize(len, 0);
            Buffer::Words(values)
        };
        let ptr = buffer.pointer();
        self.buffers.push(buffer);
        self.bytes += bytes;
        ptr
    }
    fn bytes(&self, pointer: usize, len: u32) -> Result<&[u8], u32> {
        match self
            .buffers
            .iter()
            .find(|b| b.pointer() == pointer && b.kind() == 0 && b.len() == len as usize)
        {
            Some(Buffer::Bytes(bytes)) => Ok(bytes),
            _ => Err(INVALID),
        }
    }
    fn decode(
        &mut self,
        input: usize,
        input_len: u32,
        offset: u32,
        count: u32,
        stride: u32,
        component: u32,
        components: u32,
        output: usize,
        output_len: u32,
    ) -> Result<(), u32> {
        let input_index = self
            .buffers
            .iter()
            .position(|b| b.pointer() == input && b.kind() == 0 && b.len() == input_len as usize)
            .ok_or(INVALID)?;
        let output_index = self
            .buffers
            .iter()
            .position(|b| b.pointer() == output && b.kind() == 1 && b.len() == output_len as usize)
            .ok_or(INVALID)?;
        let width = match component {
            5121 if components == 1 => 1,
            5123 if components == 1 => 2,
            5126 if components == 2 || components == 3 => 4,
            _ => return Err(PROFILE),
        };
        let count = count as usize;
        let components = components as usize;
        if count == 0
            || count > MAX_ELEMENTS
            || count.checked_mul(components) != Some(output_len as usize)
        {
            return Err(BOUNDS);
        }
        let packed = components * width;
        let stride = if stride == 0 { packed } else { stride as usize };
        if stride < packed
            || stride > 252
            || !stride.is_multiple_of(width)
            || !(offset as usize).is_multiple_of(width)
        {
            return Err(PROFILE);
        }
        let last = (offset as usize)
            .checked_add((count - 1).checked_mul(stride).ok_or(BOUNDS)?)
            .and_then(|n| n.checked_add(packed))
            .ok_or(BOUNDS)?;
        if last > input_len as usize {
            return Err(BOUNDS);
        }
        let (input, output) = if input_index < output_index {
            let (a, b) = self.buffers.split_at_mut(output_index);
            (&a[input_index], &mut b[0])
        } else {
            let (a, b) = self.buffers.split_at_mut(input_index);
            (&b[0], &mut a[output_index])
        };
        let Buffer::Bytes(input) = input else {
            return Err(INVALID);
        };
        let Buffer::Words(output) = output else {
            return Err(INVALID);
        };
        for row in 0..count {
            let begin = offset as usize + row * stride;
            for col in 0..components {
                let at = begin + col * width;
                // Float32 is copied as bits, preserving signed zero/NaN payloads.
                output[row * components + col] = match width {
                    1 => u32::from(input[at]),
                    2 => u32::from(u16::from_le_bytes([input[at], input[at + 1]])),
                    _ => {
                        u32::from_le_bytes([input[at], input[at + 1], input[at + 2], input[at + 3]])
                    }
                };
            }
        }
        Ok(())
    }
}
fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}
fn envelope(bytes: &[u8]) -> Result<(), u32> {
    if bytes.len() < 28
        || !bytes.len().is_multiple_of(4)
        || word(bytes, 0) != 0x46546c67
        || word(bytes, 4) != 2
        || word(bytes, 8) as usize != bytes.len()
    {
        return Err(PROFILE);
    }
    let json = word(bytes, 12) as usize;
    if json == 0 || !json.is_multiple_of(4) || word(bytes, 16) != 0x4e4f534a {
        return Err(PROFILE);
    }
    let bin = 20_usize.checked_add(json).ok_or(BOUNDS)?;
    if bin.checked_add(8).ok_or(BOUNDS)? > bytes.len() || word(bytes, bin + 4) != 0x004e4942 {
        return Err(PROFILE);
    }
    let size = word(bytes, bin) as usize;
    if !size.is_multiple_of(4)
        || bin.checked_add(8).and_then(|v| v.checked_add(size)) != Some(bytes.len())
    {
        return Err(PROFILE);
    }
    Ok(())
}
thread_local! { static STATE: RefCell<Registry> = RefCell::new(Registry::default()); }
fn with<T>(failure: T, run: impl FnOnce(&mut Registry) -> T) -> T {
    STATE.with(|r| match r.try_borrow_mut() {
        Ok(mut r) => run(&mut r),
        Err(_) => failure,
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn google_abi_version() -> u32 {
    1
}
/// kind0 bytes, kind1 u32 words (including Float32 bits); len counts elements.
#[unsafe(no_mangle)]
pub extern "C" fn google_alloc(kind: u32, len: u32) -> usize {
    with(0, |r| r.alloc(kind, len))
}
#[unsafe(no_mangle)]
pub extern "C" fn google_free(kind: u32, pointer: usize, len: u32) -> u32 {
    with(INVALID, |r| {
        let Some(index) = r
            .buffers
            .iter()
            .position(|b| b.pointer() == pointer && b.kind() == kind && b.len() == len as usize)
        else {
            return INVALID;
        };
        let buffer = r.buffers.swap_remove(index);
        r.bytes -= buffer.bytes();
        0
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn google_validate_glb(pointer: usize, len: u32) -> u32 {
    with(INVALID, |r| {
        r.bytes(pointer, len).and_then(envelope).err().unwrap_or(0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn google_decode_accessor(
    input: usize,
    input_len: u32,
    offset: u32,
    count: u32,
    stride: u32,
    component: u32,
    components: u32,
    output: usize,
    output_len: u32,
) -> u32 {
    with(INVALID, |r| {
        r.decode(
            input, input_len, offset, count, stride, component, components, output, output_len,
        )
        .err()
        .unwrap_or(0)
    })
}
