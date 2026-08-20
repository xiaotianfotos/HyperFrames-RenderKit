window.__timelines = window.__timelines || {};
window.__timelines.fixture = gsap.timeline({ paused: true });
window.__timelines.fixture.to("#nested-context", { opacity: 0.6, duration: 1 });
