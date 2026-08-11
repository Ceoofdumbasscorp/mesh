/** Render untrusted daemon fields without allowing terminal control sequences. */
export function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    switch (char) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
}
