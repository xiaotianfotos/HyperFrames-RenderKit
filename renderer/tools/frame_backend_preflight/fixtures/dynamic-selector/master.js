const tl = { to() {}, seek() {} };
function reveal(selector) {
  tl.to(selector, { opacity: 1 });
}
reveal("#label");
window.__timelines = { main: tl };
