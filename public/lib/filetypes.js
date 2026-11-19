// Recipe file types the app can read (shared by the phone-side reader and the server's folder picker).
export const SUPPORTED = ['.pdf', '.txt', '.md', '.markdown', '.text', '.rtf', '.html', '.htm', '.docx', '.json'];
export const extOf = (name) => (String(name).match(/\.[^./]+$/)?.[0] || '').toLowerCase();
export const isSupported = (name) => SUPPORTED.includes(extOf(name));
