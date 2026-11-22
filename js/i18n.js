// Messages set from JavaScript are written in English in app.js; t() fills in {placeholders}.
export function t(text, vars = {}) {
  return text.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : ""));
}
