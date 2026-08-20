(() => {
  "use strict";

  const WIDTH = 640;
  const HEIGHT = 480;
  const goldenSlot = document.getElementById("golden-slot");
  const captureCanvas = document.getElementById("capture-canvas");
  const captureContext = captureCanvas.getContext("2d", { alpha: false, desynchronized: true });
  const activeStreams = [];
  const sourceCanvases = [];
  const pageErrors = [];
  let targetRoot = null;

  const featureRegions = [
    { name: "transform-radius-filter", x: 18, y: 18, width: 300, height: 218 },
    { name: "backdrop-filter", x: 310, y: 20, width: 310, height: 220 },
    { name: "nested-stacking", x: 30, y: 235, width: 580, height: 220 },
  ];

  function nextAnimationFrames(count = 2, timeoutMs = 2000) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(reason);
      };
      const step = () => {
        if (count <= 0) {
          setTimeout(() => finish("raf"), 0);
          return;
        }
        count -= 1;
        requestAnimationFrame(step);
      };
      timer = setTimeout(() => finish("raf-timeout"), timeoutMs);
      step();
    });
  }

  function stopMedia() {
    for (const stream of activeStreams.splice(0)) {
      for (const track of stream.getTracks()) track.stop();
    }
    for (const canvas of sourceCanvases.splice(0)) canvas.remove();
  }

  function drawPattern(canvas, variant) {
    const context = canvas.getContext("2d", { alpha: true });
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);
    const gradient = context.createLinearGradient(0, 0, width, height);
    if (variant === "backdrop") {
      gradient.addColorStop(0, "rgba(79, 235, 255, 0.86)");
      gradient.addColorStop(0.5, "rgba(255, 255, 255, 0.12)");
      gradient.addColorStop(1, "rgba(255, 88, 178, 0.78)");
    } else if (variant === "stack") {
      gradient.addColorStop(0, "#0ee4a4");
      gradient.addColorStop(0.52, "#4b8cff");
      gradient.addColorStop(1, "#c45cff");
    } else {
      gradient.addColorStop(0, "#10d7ff");
      gradient.addColorStop(0.48, "#3465ff");
      gradient.addColorStop(1, "#ff3c9e");
    }
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = "screen";
    for (let index = 0; index < 8; index += 1) {
      context.fillStyle = `hsla(${(index * 47 + variant.length * 13) % 360} 90% 65% / 0.48)`;
      context.beginPath();
      context.arc(
        ((index * 83 + 37) % width),
        ((index * 59 + 29) % height),
        12 + (index % 3) * 11,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "rgba(3, 8, 20, 0.76)";
    context.fillRect(12, height - 43, width - 24, 31);
    context.fillStyle = "#fff";
    context.font = `800 ${Math.max(15, Math.round(height / 9))}px system-ui, sans-serif`;
    context.textBaseline = "middle";
    context.fillText(`CANVAS · ${variant.toUpperCase()}`, 22, height - 27);
  }

  function createProxy(className, width, height, variant) {
    const canvas = document.createElement("canvas");
    canvas.className = className;
    canvas.width = width;
    canvas.height = height;
    canvas.dataset.proxyVariant = variant;
    drawPattern(canvas, variant);
    return canvas;
  }

  function buildChildCanvasRoot(prefix) {
    const root = document.createElement("main");
    root.id = `${prefix}-root`;
    root.className = "probe-root child-canvas-root";
    root.dataset.case = "child-canvas";

    const transformed = createProxy("proxy-transform-filter", 238, 158, "transform");
    transformed.id = `${prefix}-proxy-transform`;
    root.appendChild(transformed);

    const backdrop = createProxy("proxy-backdrop", 232, 154, "backdrop");
    backdrop.id = `${prefix}-proxy-backdrop`;
    root.appendChild(backdrop);

    const stackZone = document.createElement("section");
    stackZone.className = "stack-zone";
    stackZone.id = `${prefix}-stack-zone`;
    const underlay = document.createElement("div");
    underlay.className = "stack-underlay";
    const stackingProxy = createProxy("proxy-stacking", 356, 126, "stack");
    stackingProxy.id = `${prefix}-proxy-stacking`;
    const overline = document.createElement("div");
    overline.className = "stack-overline";
    const copy = document.createElement("div");
    copy.className = "stack-copy";
    copy.textContent = "HTML z:7 · line z:5 · child canvas z:3";
    stackZone.append(underlay, stackingProxy, overline, copy);
    root.appendChild(stackZone);

    const label = document.createElement("div");
    label.className = "case-label";
    label.textContent = "CHILD CANVAS · CSS TREE";
    root.appendChild(label);
    return root;
  }

  function drawVideoSource(canvas) {
    const context = canvas.getContext("2d", { alpha: false });
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#00e7ff");
    gradient.addColorStop(0.34, "#2355ff");
    gradient.addColorStop(0.68, "#ff45b5");
    gradient.addColorStop(1, "#ffb52c");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 48) {
      for (let x = 0; x < canvas.width; x += 48) {
        context.fillStyle = (x / 48 + y / 48) % 2 === 0 ? "rgba(255,255,255,.25)" : "rgba(0,0,0,.18)";
        context.fillRect(x, y, 48, 48);
      }
    }
    context.fillStyle = "rgba(0,0,0,.72)";
    context.fillRect(66, 164, 508, 150);
    context.fillStyle = "white";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "900 58px system-ui, sans-serif";
    context.fillText("DIRECT <VIDEO>", 320, 218);
    context.font = "700 25px ui-monospace, monospace";
    context.fillStyle = "#8ff8ff";
    context.fillText("EXTERNAL COMPOSITOR CONTROL", 320, 274);
  }

  async function createDirectVideo(prefix) {
    const source = document.createElement("canvas");
    source.className = "source-canvas";
    source.width = WIDTH;
    source.height = HEIGHT;
    source.id = `${prefix}-stream-source`;
    drawVideoSource(source);
    document.body.appendChild(source);
    sourceCanvases.push(source);

    const stream = source.captureStream(30);
    activeStreams.push(stream);
    const video = document.createElement("video");
    video.id = `${prefix}-direct-video`;
    video.className = "direct-video";
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    return { video, source, stream };
  }

  async function waitForVideoFrame(video, source) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timed out preparing ${video.id}`)), 8000);
    });
    const ready = (async () => {
      await video.play();
      const track = video.srcObject?.getVideoTracks?.()[0];
      track?.requestFrame?.();
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await new Promise((resolve, reject) => {
          video.addEventListener("loadeddata", resolve, { once: true });
          video.addEventListener("error", () => reject(new Error(video.error?.message || `Video error ${video.id}`)), { once: true });
        });
      }
      if (typeof video.requestVideoFrameCallback === "function") {
        await new Promise((resolve) => video.requestVideoFrameCallback((_now, metadata) => resolve(metadata)));
      } else {
        await nextAnimationFrames(3);
      }
    })();
    try {
      return await Promise.race([ready, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function buildDirectVideoRoot(prefix) {
    const root = document.createElement("main");
    root.id = `${prefix}-root`;
    root.className = "probe-root direct-video-root";
    root.dataset.case = "direct-video";
    const media = await createDirectVideo(prefix);
    root.appendChild(media.video);
    return { root, ...media };
  }

  async function waitForPaint() {
    const rafReason = await nextAnimationFrames(2);
    if (rafReason === "raf-timeout") return rafReason;
    if (typeof captureCanvas.requestPaint !== "function") return "requestPaint-unavailable";
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        captureCanvas.removeEventListener("paint", onPaint);
        clearTimeout(timer);
        resolve(reason);
      };
      const onPaint = () => finish("paint-event");
      captureCanvas.addEventListener("paint", onPaint, { once: true });
      const timer = setTimeout(() => finish("paint-timeout"), 1000);
      captureCanvas.requestPaint();
    });
  }

  async function prepareCase(name) {
    stopMedia();
    goldenSlot.replaceChildren();
    captureCanvas.replaceChildren();
    captureContext.clearRect(0, 0, WIDTH, HEIGHT);
    let readiness = [];
    if (name === "child-canvas") {
      const goldenRoot = buildChildCanvasRoot("golden");
      targetRoot = buildChildCanvasRoot("target");
      goldenSlot.appendChild(goldenRoot);
      captureCanvas.appendChild(targetRoot);
    } else if (name === "direct-video") {
      const golden = await buildDirectVideoRoot("golden-video");
      const target = await buildDirectVideoRoot("target-video");
      goldenSlot.appendChild(golden.root);
      captureCanvas.appendChild(target.root);
      targetRoot = target.root;
      readiness = [
        waitForVideoFrame(golden.video, golden.source),
        waitForVideoFrame(target.video, target.source),
      ];
    } else {
      throw new Error(`Unknown probe case ${name}`);
    }
    await Promise.all(readiness);
    await document.fonts.ready;
    const paintReason = await waitForPaint();
    const rect = goldenSlot.firstElementChild.getBoundingClientRect();
    const targetRect = targetRoot.getBoundingClientRect();
    const captureRect = captureCanvas.getBoundingClientRect();
    const layout = {
      documentVisibility: document.visibilityState,
      targetConnected: targetRoot.isConnected,
      targetParentTag: targetRoot.parentElement?.tagName ?? null,
      targetRect: {
        x: Math.round(targetRect.x),
        y: Math.round(targetRect.y),
        width: Math.round(targetRect.width),
        height: Math.round(targetRect.height),
      },
      captureRect: {
        x: Math.round(captureRect.x),
        y: Math.round(captureRect.y),
        width: Math.round(captureRect.width),
        height: Math.round(captureRect.height),
      },
      layoutSubtreeAttribute: captureCanvas.hasAttribute("layoutsubtree"),
      captureChildCount: captureCanvas.children.length,
      paintReason,
    };
    if (!layout.targetConnected
      || layout.targetParentTag !== "CANVAS"
      || layout.targetRect.width !== WIDTH
      || layout.targetRect.height !== HEIGHT) {
      throw new Error(`Canvas fallback child did not receive a ${WIDTH}x${HEIGHT} layout box: ${JSON.stringify(layout)}`);
    }
    return {
      name,
      goldenRect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      featureRegions: name === "child-canvas" ? featureRegions : [{ name: "direct-video", x: 0, y: 0, width: WIDTH, height: HEIGHT }],
      paintReason,
      layout,
    };
  }

  async function captureTarget() {
    if (!targetRoot) throw new Error("prepareCase must run before captureTarget");
    if (typeof captureContext.drawElementImage !== "function") {
      throw new Error("CanvasRenderingContext2D.drawElementImage is unavailable");
    }
    const targetRect = targetRoot.getBoundingClientRect();
    if (!targetRoot.isConnected
      || targetRoot.parentElement !== captureCanvas
      || Math.round(targetRect.width) !== WIDTH
      || Math.round(targetRect.height) !== HEIGHT) {
      throw new Error(`Target root became invalid before capture: ${JSON.stringify({
        connected: targetRoot.isConnected,
        parent: targetRoot.parentElement?.tagName ?? null,
        rect: { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height },
      })}`);
    }
    const paintReason = await waitForPaint();
    captureContext.clearRect(0, 0, WIDTH, HEIGHT);
    const startedAt = performance.now();
    captureContext.drawElementImage(targetRoot, 0, 0);
    const drawElementImageMs = performance.now() - startedAt;
    // Force the canvas command stream to become observable before serializing.
    captureContext.getImageData(0, 0, 1, 1);
    return {
      dataUrl: captureCanvas.toDataURL("image/png"),
      drawElementImageMs,
      paintReason,
    };
  }

  function support() {
    const test = document.createElement("div");
    test.style.cssText = "transform:rotate(1deg);border-radius:12px;filter:blur(1px);backdrop-filter:blur(1px)";
    document.body.appendChild(test);
    const computed = getComputedStyle(test);
    const backdropFilter = computed.backdropFilter || computed.webkitBackdropFilter || "";
    const result = {
      drawElementImage: typeof captureContext?.drawElementImage === "function",
      requestPaint: typeof captureCanvas.requestPaint === "function",
      cssTransform: computed.transform !== "none",
      cssBorderRadius: computed.borderRadius !== "0px",
      cssFilter: computed.filter !== "none",
      cssBackdropFilter: backdropFilter !== "" && backdropFilter !== "none",
      canvasCaptureStream: typeof HTMLCanvasElement.prototype.captureStream === "function",
      requestVideoFrameCallback: typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function",
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
    };
    test.remove();
    return result;
  }

  function diagnostics() {
    const canvasRect = captureCanvas.getBoundingClientRect();
    return {
      documentReadyState: document.readyState,
      documentVisibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      devicePixelRatio: window.devicePixelRatio,
      canvasConnected: captureCanvas.isConnected,
      canvasRect: {
        x: Math.round(canvasRect.x),
        y: Math.round(canvasRect.y),
        width: Math.round(canvasRect.width),
        height: Math.round(canvasRect.height),
      },
      canvasBackingSize: { width: captureCanvas.width, height: captureCanvas.height },
      layoutSubtreeAttribute: captureCanvas.hasAttribute("layoutsubtree"),
      captureChildCount: captureCanvas.children.length,
      targetConnected: targetRoot?.isConnected ?? false,
      errors: [...pageErrors],
    };
  }

  window.addEventListener("error", (event) => {
    pageErrors.push({
      type: "error",
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    pageErrors.push({
      type: "unhandledrejection",
      message: event.reason?.stack ?? String(event.reason),
    });
  });

  window.childCanvasProxyProbe = {
    width: WIDTH,
    height: HEIGHT,
    support,
    diagnostics,
    prepareCase,
    captureTarget,
  };
  window.__childCanvasProxyProbeReady = document.fonts.ready.then(() => support());
})();
