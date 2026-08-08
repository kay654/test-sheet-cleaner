(() => {
  "use strict";

  const ASSET_VERSION = 1;
  const PROCESSOR_PROTOCOL_VERSION = 1;
  const PROCESSOR_TIMEOUT_MS = 90_000;
  const DOCUMENT_DETECTION_MAX_DIMENSION = 1200;
  const MAX_PIXELS = 14_000_000;
  const MAX_FILE_BYTES = 80 * 1024 * 1024;
  const SUPPORTED_EXTENSIONS = ["jpg", "jpeg", "jfif", "png", "webp", "avif", "bmp", "heic", "heif"];
  const SUPPORTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/bmp", "image/heic", "image/heif"];
  const PHASE_LABELS = {
    idle: "画像を選んでください",
    loading: "画像を読み込んでいます",
    framing: "用紙の四隅を確認してください",
    extracting: "傾きと影を補正しています",
    analyzing: "用紙の状態を解析しています",
    detecting: "書き込み候補を検出しています",
    restoring: "用紙を整えています",
    complete: "処理が完了しました",
    error: "処理を完了できません",
  };
  const BUSY_PHASES = new Set(["loading", "extracting", "analyzing", "detecting", "restoring"]);
  const CORNER_NAMES = ["左上", "右上", "右下", "左下"];

  const byId = (id) => document.getElementById(id);
  const elements = {
    shell: byId("app-shell"), welcome: byId("welcome"), workspace: byId("workspace"),
    welcomeLead: byId("welcome-lead"), welcomeError: byId("welcome-error"), workspaceError: byId("workspace-error"),
    dropZone: byId("drop-zone"), dropTitle: byId("drop-title"), dropDescription: byId("drop-description"),
    fileName: byId("file-name"), statusChip: byId("status-chip"), statusSpinner: byId("status-spinner"),
    phaseLabel: byId("phase-label"), overlayPhaseLabel: byId("overlay-phase-label"), downscaled: byId("downscaled-notice"),
    mobileEditor: byId("mobile-editor"), mobileDescription: byId("mobile-editor-description"), mobileBadge: byId("mobile-detection-badge"),
    cropContainer: byId("document-crop-canvas"), cropOverlay: byId("document-crop-overlay"), cropBusy: byId("document-crop-busy"),
    processingArea: byId("processing-area"), comparison: byId("comparison-workbench"), editToolbar: byId("edit-toolbar"),
    sourceCanvas: byId("source-canvas"), resultCanvas: byId("result-canvas"), referenceCanvas: byId("reference-canvas"), printCanvas: byId("print-canvas"),
    sourceStage: byId("source-stage"), resultStage: byId("result-stage"), sourceSurface: byId("source-surface"), resultSurface: byId("result-surface"),
    processingOverlay: byId("processing-overlay"), dimensions: byId("image-dimensions"), editingChip: byId("editing-chip"), editCursor: byId("edit-cursor"),
    zoomControl: byId("zoom-control"), zoomFit: byId("zoom-fit"), zoomOutput: byId("zoom-output"), editToolControl: byId("edit-tool-control"), cleaningMode: byId("cleaning-mode"),
    editToggle: byId("edit-toggle"), rotate: byId("rotate-document"), save: byId("save-image"), print: byId("print-image"),
    brushSize: byId("brush-size"), undo: byId("undo-edit"), redo: byId("redo-edit"), strength: byId("strength"), strengthOutput: byId("strength-output"),
    reprocess: byId("reprocess"), referencePresent: byId("reference-present"), referenceLabel: byId("reference-label"), chooseReference: byId("choose-reference"),
    extract: byId("extract-document"), retry: byId("retry-document"), skip: byId("skip-document"),
    input: byId("image-input"), referenceInput: byId("reference-input"),
  };

  const state = {
    phase: "idle", fileName: "", referenceName: "", dimensions: null, sourceDimensions: null,
    error: "", isDragging: false, strength: 3, removeColor: true, removePencil: true,
    editing: false, editTool: "erase", editCursor: null, editAvailability: { undo: false, redo: false },
    brushSize: 34, zoom: 100, mobileDevice: detectMobileDevice(), mobileDocument: null,
  };
  const runtime = {
    referenceReady: false, worker: null, workerFailure: null, workerRequestId: 0,
    editBase: null, editHistory: [], editRedo: [], currentStroke: null,
    syncingScroll: false, scrollSyncFrame: null, cropLayoutFrame: null, activeCorner: null, heicLoader: null,
    sessionRevision: 0, processingRevision: 0,
    workerCancellations: new Set(),
  };

  function beginSession() {
    runtime.sessionRevision += 1;
    runtime.processingRevision += 1;
    if (runtime.workerCancellations.size) {
      runtime.worker?.terminate();
      runtime.worker = null;
      for (const cancel of [...runtime.workerCancellations]) {
        cancel(new Error("PROCESSOR_CANCELLED"));
      }
      initializeWorker();
    }
    return runtime.sessionRevision;
  }

  function isCurrentSession(sessionRevision) {
    return sessionRevision === runtime.sessionRevision;
  }

  function initialDocumentCorners() {
    return [{ x: 0.045, y: 0.045 }, { x: 0.955, y: 0.045 }, { x: 0.955, y: 0.955 }, { x: 0.045, y: 0.955 }];
  }

  function detectMobileDevice() {
    if (new URLSearchParams(location.search).get("mobile-preview") === "1") return true;
    if (typeof navigator.userAgentData?.mobile === "boolean") return navigator.userAgentData.mobile;
    if (/Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent)) return true;
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  }

  function isIOSDevice() {
    return /iPad|iPhone|iPod/i.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function setState(patch) {
    Object.assign(state, patch);
    render();
  }

  function setHidden(element, hidden) {
    if (element) element.hidden = Boolean(hidden);
  }

  function setButtonGroup(container, attribute, activeValue) {
    for (const button of container.querySelectorAll(`button[${attribute}]`)) {
      const active = button.getAttribute(attribute) === String(activeValue);
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function edgeStyle(element, first, second, canvasWidth, canvasHeight) {
    // Percentage widths are measured against the container's *width*.  That
    // makes vertical edges too short on portrait photos, so calculate the
    // segment length in the displayed canvas's pixel coordinate system.
    const dx = (second.x - first.x) * canvasWidth;
    const dy = (second.y - first.y) * canvasHeight;
    Object.assign(element.style, {
      left: `${first.x * 100}%`, top: `${first.y * 100}%`,
      width: `${Math.hypot(dx, dy)}px`, transform: `rotate(${Math.atan2(dy, dx)}rad)`,
    });
  }

  function renderCorners() {
    if (!state.mobileDocument) return;
    const corners = state.mobileDocument.corners;
    const canvasWidth = elements.cropOverlay.clientWidth;
    const canvasHeight = elements.cropOverlay.clientHeight;
    const [topLeft, topRight, bottomRight, bottomLeft] = corners;
    const clips = [
      `polygon(0 0, 100% 0, ${topRight.x * 100}% ${topRight.y * 100}%, ${topLeft.x * 100}% ${topLeft.y * 100}%)`,
      `polygon(${topRight.x * 100}% ${topRight.y * 100}%, 100% 0, 100% 100%, ${bottomRight.x * 100}% ${bottomRight.y * 100}%)`,
      `polygon(${bottomLeft.x * 100}% ${bottomLeft.y * 100}%, ${bottomRight.x * 100}% ${bottomRight.y * 100}%, 100% 100%, 0 100%)`,
      `polygon(0 0, ${topLeft.x * 100}% ${topLeft.y * 100}%, ${bottomLeft.x * 100}% ${bottomLeft.y * 100}%, 0 100%)`,
    ];
    [...elements.cropOverlay.querySelectorAll(".document-crop-shade")].forEach((item, index) => { item.style.clipPath = clips[index]; });
    [...elements.cropOverlay.querySelectorAll(".document-crop-edge")].forEach((item, index) =>
      edgeStyle(item, corners[index], corners[(index + 1) % 4], canvasWidth, canvasHeight));
    [...elements.cropOverlay.querySelectorAll(".document-corner-handle")].forEach((item, index) => {
      item.style.left = `${corners[index].x * 100}%`;
      item.style.top = `${corners[index].y * 100}%`;
      item.disabled = state.mobileDocument.status !== "editing";
      item.setAttribute("aria-label", `${CORNER_NAMES[index]}の角`);
    });
  }

  function synchronizeCropPresentation() {
    runtime.cropLayoutFrame = null;
    if (!state.mobileDocument || !state.dimensions || !elements.cropContainer.parentElement) return;
    const stage = elements.cropContainer.parentElement;
    const availableWidth = Math.max(1, stage.clientWidth - 20);
    const availableHeight = Math.max(1, stage.clientHeight - 20);
    const ratio = state.dimensions.width / state.dimensions.height;
    const width = Math.min(availableWidth, availableHeight * ratio);
    const height = width / ratio;
    Object.assign(elements.cropContainer.style, {
      width: `${width}px`, height: `${height}px`, aspectRatio: "auto",
    });
    Object.assign(elements.sourceCanvas.style, {
      width: "100%", height: "100%", maxWidth: "none", maxHeight: "none",
    });
  }

  function scheduleCropPresentationSync() {
    if (runtime.cropLayoutFrame !== null) cancelAnimationFrame(runtime.cropLayoutFrame);
    runtime.cropLayoutFrame = requestAnimationFrame(synchronizeCropPresentation);
  }

  function renderEditCursor() {
    setHidden(elements.editCursor, !state.editing || !state.editCursor);
    if (state.editCursor) {
      const size = state.brushSize;
      Object.assign(elements.editCursor.style, {
        left: `${state.editCursor.left}px`, top: `${state.editCursor.top}px`,
        width: `${size}px`, height: `${size}px`,
      });
    }
    elements.editCursor.className = `edit-cursor edit-cursor-${state.editTool}`;
  }

  function render() {
    const hasImage = Boolean(state.dimensions);
    const busy = BUSY_PHASES.has(state.phase);
    const mobileEditing = Boolean(state.mobileDocument && state.dimensions);
    elements.shell.classList.toggle("mobile-device", state.mobileDevice);
    elements.welcomeLead.textContent = state.mobileDevice
      ? "撮影した用紙をスキャン画像へ整えてから書き込みを取り除きます"
      : "画像を選ぶと自動で書き込みを取り除きます";
    elements.dropTitle.textContent = state.mobileDevice ? "用紙写真を選択" : "画像を選択";
    elements.dropDescription.textContent = state.mobileDevice ? "写真を選ぶか、その場で撮影できます" : "ここにドロップすることもできます";
    byId("choose-image").textContent = state.mobileDevice ? "写真を選ぶ・撮影" : "画像を選ぶ";
    elements.dropZone.classList.toggle("is-dragging", state.isDragging);
    setHidden(elements.welcome, hasImage);
    setHidden(elements.workspace, !hasImage);
    elements.fileName.textContent = state.fileName;
    elements.phaseLabel.textContent = PHASE_LABELS[state.phase];
    elements.overlayPhaseLabel.textContent = PHASE_LABELS[state.phase];
    elements.statusChip.className = `status-chip status-${state.phase}`;
    setHidden(elements.statusSpinner, !busy);
    const wasDownscaled = state.dimensions && state.sourceDimensions &&
      (state.dimensions.width !== state.sourceDimensions.width || state.dimensions.height !== state.sourceDimensions.height);
    setHidden(elements.downscaled, !wasDownscaled);
    for (const banner of [elements.welcomeError, elements.workspaceError]) {
      setHidden(banner, !state.error);
      banner.querySelector("[data-error-message]").textContent = state.error;
    }

    setHidden(elements.mobileEditor, !mobileEditing);
    setHidden(elements.processingArea, mobileEditing);
    if (mobileEditing) {
      if (elements.sourceCanvas.parentElement !== elements.cropContainer) elements.cropContainer.insertBefore(elements.sourceCanvas, elements.cropOverlay);
      elements.cropContainer.style.aspectRatio = `${state.dimensions.width} / ${state.dimensions.height}`;
      const detecting = state.mobileDocument.status === "detecting";
      const extracting = state.mobileDocument.status === "extracting";
      elements.mobileDescription.textContent = state.mobileDocument.detected
        ? "四隅を確認し、ずれていれば動かしてください" : "四隅を用紙の角へ合わせてください";
      elements.mobileBadge.className = state.mobileDocument.detected ? "document-detected" : "document-manual";
      elements.mobileBadge.textContent = state.mobileDocument.detected ? "自動検出" : "手動調整";
      setHidden(elements.cropBusy, !(detecting || extracting));
      elements.extract.disabled = detecting || extracting;
      elements.retry.disabled = detecting || extracting;
      elements.skip.disabled = detecting || extracting;
      renderCorners();
      scheduleCropPresentationSync();
    } else if (elements.sourceCanvas.parentElement !== elements.sourceSurface) {
      elements.sourceSurface.append(elements.sourceCanvas);
    }

    const isFitZoom = state.zoom === 100;
    elements.zoomControl.value = String(state.zoom);
    elements.zoomOutput.textContent = `${state.zoom}%`;
    elements.zoomFit.classList.toggle("active", isFitZoom);
    elements.zoomFit.setAttribute("aria-pressed", String(isFitZoom));
    setButtonGroup(elements.editToolControl, "data-edit-tool", state.editTool);
    const cleaningMode = state.removeColor && state.removePencil ? "auto" : state.removeColor ? "color" : "pencil";
    setButtonGroup(elements.cleaningMode, "data-mode", cleaningMode);
    const complete = state.phase === "complete";
    elements.editToggle.disabled = !complete;
    elements.rotate.disabled = !complete;
    elements.save.disabled = !complete;
    elements.print.disabled = !complete;
    elements.editToggle.classList.toggle("active", state.editing);
    elements.editToggle.textContent = state.editing ? "手直し終了" : "手直し";
    elements.editToggle.setAttribute("aria-pressed", String(state.editing));
    setHidden(elements.editToolbar, !state.editing);
    setHidden(elements.editingChip, !state.editing);
    elements.resultStage.classList.toggle("is-editing", state.editing);
    elements.undo.disabled = !state.editAvailability.undo;
    elements.redo.disabled = !state.editAvailability.redo;
    elements.brushSize.value = String(state.brushSize);
    renderEditCursor();
    setHidden(elements.processingOverlay, !busy || mobileEditing);
    elements.dimensions.textContent = state.dimensions
      ? `${state.dimensions.width.toLocaleString()} × ${state.dimensions.height.toLocaleString()} px`
      : "";
    const canvasPadding = 32;
    const fittedWidth = Math.max(1, Math.min(
      state.dimensions?.width || 1,
      elements.sourceStage.clientWidth - canvasPadding,
      ((elements.sourceStage.clientHeight - canvasPadding) / Math.max(1, state.dimensions?.height || 1)) * (state.dimensions?.width || 1),
    ));
    const zoomScale = Number(state.zoom) / 100;
    const previewCanvases = mobileEditing ? [elements.resultCanvas] : [elements.sourceCanvas, elements.resultCanvas];
    for (const canvas of previewCanvases) {
      if (!canvas) continue;
      Object.assign(canvas.style, {
        width: `${fittedWidth * zoomScale}px`, height: "auto", maxWidth: "none", maxHeight: "none",
      });
    }
    const previewSurfaces = mobileEditing ? [elements.resultSurface] : [elements.sourceSurface, elements.resultSurface];
    for (const surface of previewSurfaces) {
      Object.assign(surface.style, {
        width: `${fittedWidth * zoomScale}px`,
        height: `${fittedWidth * zoomScale * (state.dimensions?.height || 1) / Math.max(1, state.dimensions?.width || 1)}px`,
      });
    }
    elements.strength.value = String(state.strength);
    elements.strength.setAttribute("aria-label", `検出の強さ ${state.strength}`);
    elements.strengthOutput.textContent = String(state.strength);
    elements.reprocess.disabled = busy || !hasImage || Boolean(state.referenceName);
    elements.strength.disabled = Boolean(state.referenceName);
    [...elements.cleaningMode.querySelectorAll("button")].forEach((button) => { button.disabled = Boolean(state.referenceName); });
    setHidden(elements.referencePresent, !state.referenceName);
    elements.referenceLabel.textContent = "未記入原稿あり";
    elements.referenceLabel.title = state.referenceName;
    setHidden(elements.chooseReference, Boolean(state.referenceName));
  }

  function getExtension(name) { return name.split(".").pop()?.toLowerCase() || ""; }
  function isHeic(file) {
    const extension = getExtension(file.name);
    return extension === "heic" || extension === "heif" || file.type === "image/heic" || file.type === "image/heif";
  }

  function friendlyError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNSUPPORTED_FILE")) return "このファイル形式には対応していません。JPEG、PNG、WebP、AVIF、BMP、HEIC、HEIF を選んでください。";
    if (message.includes("FILE_TOO_LARGE")) return "ファイルが大きすぎます。80MB 未満の画像を選んでください。";
    if (message.includes("REFERENCE_MISMATCH")) return "未記入画像が元画像と同じ用紙か確認できませんでした。同じページの未記入用紙を選んでください。";
    if (message.includes("REFERENCE_SIZE_MISMATCH")) return "未記入画像の縦横比が元画像と異なります。同じページの画像を選んでください。";
    if (message.includes("HEIC")) return "HEIC / HEIF 画像を開けませんでした。iPhone 側で「互換性優先」に変換するか、JPEG で共有してお試しください。";
    if (message.includes("PROCESSOR_VERSION_MISMATCH")) return "処理エンジンを最新版へ切り替えられませんでした。ページを再読み込みして、もう一度お試しください。";
    if (message.includes("PROCESSOR_UNAVAILABLE") || message.includes("PROCESSOR_TIMEOUT") || message.includes("OPENCV_JS")) return "OpenCV.jsを開始できませんでした。ページを再読み込みして、もう一度お試しください。";
    if (message.includes("IMAGE_DECODE_FAILED")) return "画像の標準読込と互換読込の両方に失敗しました。画像を開き直して保存するか、JPEGまたはPNGへ書き出してお試しください。";
    if (message.includes("DOCUMENT_AREA_TOO_SMALL")) return "切り出す範囲が小さすぎます。4つの点を用紙の四隅へ合わせてください。";
    if (message.includes("INVALID_DOCUMENT_CORNERS")) return "用紙の四隅を確認できませんでした。4つの点を用紙の角へ合わせてください。";
    if (/memory/i.test(message)) return "画像を処理するためのメモリが不足しました。ほかのタブを閉じるか、画像を小さくしてお試しください。";
    return "画像を開けませんでした。ファイルが壊れていないか確認し、別の画像でお試しください。";
  }

  async function decodeWithImageElement(blob) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = objectUrl;
      await image.decode();
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) throw new Error("IMAGE_HAS_NO_DIMENSIONS");
      return { source: image, width, height, close: () => URL.revokeObjectURL(objectUrl) };
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  async function decodeBrowserImage(blob) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      } catch {
        try {
          const bitmap = await createImageBitmap(blob);
          return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
        } catch { /* HTMLImageElement also handles some JPEG variants. */ }
      }
    }
    return decodeWithImageElement(blob);
  }

  function loadHeicConverter() {
    if (window.heic2any) return Promise.resolve(window.heic2any);
    if (runtime.heicLoader) return runtime.heicLoader;
    runtime.heicLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `./vendor/heic2any/heic2any.min.js?v=${ASSET_VERSION}`;
      script.onload = () => window.heic2any ? resolve(window.heic2any) : reject(new Error("HEIC_DECODER_UNAVAILABLE"));
      script.onerror = () => reject(new Error("HEIC_DECODER_UNAVAILABLE"));
      document.head.append(script);
    }).catch((error) => {
      runtime.heicLoader = null;
      throw error;
    });
    return runtime.heicLoader;
  }

  async function decodeImage(file) {
    if (file.type === "image/svg+xml") return decodeWithImageElement(file);
    try {
      return await decodeBrowserImage(file);
    } catch (nativeError) {
      if (!isHeic(file)) throw new Error(`IMAGE_DECODE_FAILED:${nativeError instanceof Error ? nativeError.message : nativeError}`);
      const heic2any = await loadHeicConverter();
      const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.96, multiple: false });
      return decodeBrowserImage(Array.isArray(converted) ? converted[0] : converted);
    }
  }

  function initializeWorker() {
    try {
      const workerUrl = new URL("./processor.worker.js", document.baseURI);
      workerUrl.searchParams.set("v", String(ASSET_VERSION));
      const worker = new Worker(workerUrl);
      runtime.worker = worker;
      runtime.workerFailure = null;
      worker.addEventListener("message", (event) => {
        if (event.data?.type === "startup-progress") return;
        if (event.data?.type === "startup-error") runtime.workerFailure = event.data.error || "OPENCV_JS_LOAD_FAILED";
        if (event.data?.type === "ready" && event.data.version !== PROCESSOR_PROTOCOL_VERSION) runtime.workerFailure = "PROCESSOR_VERSION_MISMATCH";
      });
      worker.addEventListener("error", () => { runtime.workerFailure = "PROCESSOR_UNAVAILABLE"; });
    } catch {
      runtime.workerFailure = "PROCESSOR_UNAVAILABLE";
    }
  }

  function requestWorker(payload, transfers = []) {
    const worker = runtime.worker;
    if (!worker || runtime.workerFailure) return Promise.reject(new Error(runtime.workerFailure || "PROCESSOR_UNAVAILABLE"));
    const id = ++runtime.workerRequestId;
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        worker.removeEventListener("message", listener);
        worker.removeEventListener("error", errorListener);
        runtime.workerCancellations.delete(cancel);
      };
      const cancel = (error) => { cleanup(); reject(error); };
      const listener = (event) => {
        if (event.data?.type === "startup-error") {
          cancel(new Error(event.data.error || "OPENCV_JS_LOAD_FAILED"));
          return;
        }
        if (event.data.id !== id) return;
        cleanup();
        if (event.data.version !== PROCESSOR_PROTOCOL_VERSION) reject(new Error("PROCESSOR_VERSION_MISMATCH"));
        else if (!event.data.ok) reject(new Error(event.data.error));
        else resolve(event.data.result);
      };
      const errorListener = () => cancel(new Error("PROCESSOR_UNAVAILABLE"));
      timeout = setTimeout(() => cancel(new Error("PROCESSOR_TIMEOUT")), PROCESSOR_TIMEOUT_MS);
      worker.addEventListener("message", listener);
      worker.addEventListener("error", errorListener);
      runtime.workerCancellations.add(cancel);
      try {
        worker.postMessage({ id, ...payload }, transfers);
      } catch (error) {
        cancel(error instanceof Error ? error : new Error("PROCESSOR_UNAVAILABLE"));
      }
    });
  }

  function synchronizePrintCanvas() {
    const source = elements.resultCanvas;
    const target = elements.printCanvas;
    if (!source.width || !source.height) return;
    if (target.width !== source.width) target.width = source.width;
    if (target.height !== source.height) target.height = source.height;
    const context = target.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(source, 0, 0);

    const aspectRatio = source.width / source.height;
    const maxWidthMm = 200;
    const maxHeightMm = 270;
    const widthMm = Math.min(maxWidthMm, maxHeightMm * aspectRatio);
    const heightMm = widthMm / aspectRatio;
    target.style.setProperty("--print-width", `${widthMm.toFixed(2)}mm`);
    target.style.setProperty("--print-height", `${heightMm.toFixed(2)}mm`);
  }

  function cleanupPrintMode() {
    document.body.classList.remove("is-printing");
    window.removeEventListener("afterprint", cleanupPrintMode);
    window.removeEventListener("focus", cleanupPrintMode);
  }

  function printFromDocument() {
    document.body.classList.add("is-printing");
    window.addEventListener("afterprint", cleanupPrintMode, { once: true });
    window.addEventListener("focus", cleanupPrintMode, { once: true });
    setTimeout(cleanupPrintMode, 10000);
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  }

  function printCanvasInIsolatedWindow(source) {
    let printWindow = null;
    try {
      printWindow = window.open("", "test-cleaner-print");
      if (!printWindow) return false;
      const printDocument = printWindow.document;
      printDocument.open();
      printDocument.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>テストクリーナー 印刷</title><style>
        @page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{width:208mm;height:294mm;margin:0;padding:0;overflow:hidden;background:#fff}body{display:flex;align-items:center;justify-content:center}canvas{display:block;width:auto;max-width:208mm;height:auto;max-height:294mm;border:0}
      </style></head><body></body></html>`);
      printDocument.close();
      const printCanvas = printDocument.createElement("canvas");
      printCanvas.width = source.width;
      printCanvas.height = source.height;
      const context = printCanvas.getContext("2d");
      if (!context) { printWindow.close(); return false; }
      context.drawImage(source, 0, 0);
      printDocument.body.append(printCanvas);
      printWindow.addEventListener("afterprint", () => setTimeout(() => printWindow?.close(), 250), { once: true });
      printWindow.focus();
      printWindow.print();
      return true;
    } catch {
      printWindow?.close();
      return false;
    }
  }

  function printResult() {
    const source = elements.resultCanvas;
    if (!isIOSDevice() && source.width && source.height && printCanvasInIsolatedWindow(source)) return;
    synchronizePrintCanvas();
    printFromDocument();
  }

  async function runProcessing(sessionRevision = runtime.sessionRevision) {
    const sourceCanvas = elements.sourceCanvas;
    const resultCanvas = elements.resultCanvas;
    if (!sourceCanvas.width || !isCurrentSession(sessionRevision)) return;
    const processingRevision = ++runtime.processingRevision;
    const isCurrent = () =>
      isCurrentSession(sessionRevision) && processingRevision === runtime.processingRevision;
    setState({ error: "", editing: false, editCursor: null, phase: "analyzing" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (!isCurrent()) return;
    try {
      const context = sourceCanvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("CANVAS_UNAVAILABLE");
      const imageData = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      let referenceImageData = null;
      if (runtime.referenceReady) {
        const referenceContext = elements.referenceCanvas.getContext("2d", { willReadFrequently: true });
        if (!referenceContext) throw new Error("CANVAS_UNAVAILABLE");
        referenceImageData = referenceContext.getImageData(0, 0, elements.referenceCanvas.width, elements.referenceCanvas.height);
      }
      setState({ phase: "detecting" });
      const transfers = [imageData.data.buffer];
      if (referenceImageData) transfers.push(referenceImageData.data.buffer);
      const result = await requestWorker({
        action: "clean",
        image: { data: imageData.data, width: imageData.width, height: imageData.height },
        options: {
          strength: state.strength,
          removeColor: state.removeColor,
          removePencil: state.removePencil,
          reference: referenceImageData ? { data: referenceImageData.data, width: referenceImageData.width, height: referenceImageData.height } : null,
        },
      }, transfers);
      if (!isCurrent()) return;
      setState({ phase: "restoring" });
      resultCanvas.width = result.width;
      resultCanvas.height = result.height;
      const resultContext = resultCanvas.getContext("2d");
      if (!resultContext) throw new Error("CANVAS_UNAVAILABLE");
      resultContext.putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
      runtime.editBase = resultContext.getImageData(0, 0, result.width, result.height);
      runtime.editHistory = [];
      runtime.editRedo = [];
      runtime.currentStroke = null;
      synchronizePrintCanvas();
      setState({ phase: "complete", editAvailability: { undo: false, redo: false } });
    } catch (error) {
      if (!isCurrent()) return;
      console.error("画像処理に失敗しました。", error);
      setState({ error: friendlyError(error), phase: "error" });
    }
  }

  async function detectDocumentFromCanvas(sessionRevision = runtime.sessionRevision) {
    const sourceCanvas = elements.sourceCanvas;
    if (!sourceCanvas.width || !isCurrentSession(sessionRevision)) return;
    state.mobileDocument = state.mobileDocument
      ? { ...state.mobileDocument, status: "detecting" }
      : { status: "detecting", corners: initialDocumentCorners(), detected: false };
    setState({ phase: "analyzing" });
    try {
      const scale = Math.min(1, DOCUMENT_DETECTION_MAX_DIMENSION / Math.max(sourceCanvas.width, sourceCanvas.height));
      const detectionCanvas = document.createElement("canvas");
      detectionCanvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
      detectionCanvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
      const context = detectionCanvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("CANVAS_UNAVAILABLE");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(sourceCanvas, 0, 0, detectionCanvas.width, detectionCanvas.height);
      const imageData = context.getImageData(0, 0, detectionCanvas.width, detectionCanvas.height);
      const detection = await requestWorker({
        action: "detect-document",
        image: { data: imageData.data, width: imageData.width, height: imageData.height },
      }, [imageData.data.buffer]);
      if (!isCurrentSession(sessionRevision)) return;
      state.mobileDocument = {
        status: "editing", corners: detection.corners,
        detected: detection.detected && detection.confidence >= 0.2,
      };
    } catch (error) {
      if (!isCurrentSession(sessionRevision)) return;
      console.warn("用紙の四隅を自動検出できませんでした。", error);
      state.mobileDocument = { status: "editing", corners: initialDocumentCorners(), detected: false };
    } finally {
      if (isCurrentSession(sessionRevision)) setState({ phase: "framing" });
    }
  }

  async function installSourceImage(image, sessionRevision = runtime.sessionRevision) {
    if (!isCurrentSession(sessionRevision)) return;
    state.mobileDocument = null;
    state.dimensions = { width: image.width, height: image.height };
    state.sourceDimensions = { width: image.width, height: image.height };
    render();
    elements.sourceCanvas.width = image.width;
    elements.sourceCanvas.height = image.height;
    elements.resultCanvas.width = image.width;
    elements.resultCanvas.height = image.height;
    const sourceContext = elements.sourceCanvas.getContext("2d", { willReadFrequently: true });
    const resultContext = elements.resultCanvas.getContext("2d");
    if (!sourceContext || !resultContext) throw new Error("CANVAS_UNAVAILABLE");
    sourceContext.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    resultContext.clearRect(0, 0, image.width, image.height);
    setTimeout(() => {
      if (isCurrentSession(sessionRevision)) void runProcessing(sessionRevision);
    }, 30);
  }

  async function extractMobileDocument() {
    if (!elements.sourceCanvas.width || !state.mobileDocument || state.mobileDocument.status !== "editing") return;
    const sessionRevision = runtime.sessionRevision;
    state.mobileDocument = { ...state.mobileDocument, status: "extracting" };
    setState({ error: "", phase: "extracting" });
    try {
      const context = elements.sourceCanvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("CANVAS_UNAVAILABLE");
      const imageData = context.getImageData(0, 0, elements.sourceCanvas.width, elements.sourceCanvas.height);
      const result = await requestWorker({
        action: "extract-document",
        image: { data: imageData.data, width: imageData.width, height: imageData.height },
        options: { corners: state.mobileDocument.corners, normalizeLighting: true },
      }, [imageData.data.buffer]);
      if (!isCurrentSession(sessionRevision)) return;
      await installSourceImage(result, sessionRevision);
    } catch (error) {
      if (!isCurrentSession(sessionRevision)) return;
      console.error("用紙の抽出に失敗しました。", error);
      if (state.mobileDocument) state.mobileDocument = { ...state.mobileDocument, status: "editing" };
      setState({ error: friendlyError(error), phase: "error" });
    }
  }

  async function acceptOriginalMobilePhoto() {
    const sessionRevision = runtime.sessionRevision;
    const context = elements.sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!context || !elements.sourceCanvas.width) return;
    const imageData = context.getImageData(0, 0, elements.sourceCanvas.width, elements.sourceCanvas.height);
    try {
      await installSourceImage(
        { data: new Uint8ClampedArray(imageData.data), width: imageData.width, height: imageData.height },
        sessionRevision,
      );
    } catch (error) {
      if (!isCurrentSession(sessionRevision)) return;
      setState({ error: friendlyError(error), phase: "error" });
    }
  }

  function supportedFile(file, allowInternalSvg) {
    const extension = getExtension(file.name);
    return SUPPORTED_EXTENSIONS.includes(extension) || SUPPORTED_MIME_TYPES.includes(file.type) ||
      (allowInternalSvg && extension === "svg" && file.type === "image/svg+xml");
  }

  async function loadFile(file, allowInternalSvg = false, requestedSession = null) {
    const sessionRevision = requestedSession ?? beginSession();
    if (!isCurrentSession(sessionRevision)) return;
    if (!supportedFile(file, allowInternalSvg)) {
      setState({ error: friendlyError(new Error("UNSUPPORTED_FILE")), phase: "error" });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setState({ error: friendlyError(new Error("FILE_TOO_LARGE")), phase: "error" });
      return;
    }
    runtime.referenceReady = false;
    elements.referenceCanvas.width = 0;
    elements.referenceCanvas.height = 0;
    const useMobileScanner = state.mobileDevice && !allowInternalSvg;
    Object.assign(state, {
      fileName: file.name, referenceName: "", error: "", phase: "loading",
      mobileDocument: useMobileScanner ? { status: "detecting", corners: initialDocumentCorners(), detected: false } : null,
    });
    render();
    let bitmap = null;
    try {
      bitmap = await decodeImage(file);
      if (!isCurrentSession(sessionRevision)) return;
      const originalWidth = bitmap.width;
      const originalHeight = bitmap.height;
      const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      Object.assign(state, { dimensions: { width, height }, sourceDimensions: { width: originalWidth, height: originalHeight } });
      render();
      elements.sourceCanvas.width = width;
      elements.sourceCanvas.height = height;
      elements.resultCanvas.width = width;
      elements.resultCanvas.height = height;
      const sourceContext = elements.sourceCanvas.getContext("2d");
      const resultContext = elements.resultCanvas.getContext("2d");
      if (!sourceContext || (!useMobileScanner && !resultContext)) throw new Error("CANVAS_UNAVAILABLE");
      sourceContext.imageSmoothingEnabled = true;
      sourceContext.imageSmoothingQuality = "high";
      sourceContext.drawImage(bitmap.source, 0, 0, width, height);
      resultContext?.clearRect(0, 0, width, height);
      setTimeout(() => {
        if (!isCurrentSession(sessionRevision)) return;
        void (useMobileScanner
          ? detectDocumentFromCanvas(sessionRevision)
          : runProcessing(sessionRevision));
      }, 30);
    } catch (error) {
      if (!isCurrentSession(sessionRevision)) return;
      console.error("画像の読み込みに失敗しました。", error);
      const normalized = isHeic(file) && error instanceof Error ? new Error(`HEIC_DECODE_FAILED: ${error.message}`) : error;
      setState({ error: friendlyError(normalized), phase: "error" });
    } finally {
      bitmap?.close();
    }
  }

  async function loadReferenceFile(file) {
    if (!state.dimensions) return;
    const sessionRevision = beginSession();
    if (!supportedFile(file, false)) { setState({ error: friendlyError(new Error("UNSUPPORTED_FILE")) }); return; }
    if (file.size > MAX_FILE_BYTES) { setState({ error: friendlyError(new Error("FILE_TOO_LARGE")) }); return; }
    setState({ error: "", phase: "loading" });
    let bitmap = null;
    try {
      bitmap = await decodeImage(file);
      if (!isCurrentSession(sessionRevision)) return;
      const sourceRatio = state.dimensions.width / state.dimensions.height;
      const referenceRatio = bitmap.width / bitmap.height;
      if (Math.abs(sourceRatio - referenceRatio) / sourceRatio > 0.025) {
        throw new Error("REFERENCE_SIZE_MISMATCH");
      }
      elements.referenceCanvas.width = state.dimensions.width;
      elements.referenceCanvas.height = state.dimensions.height;
      const context = elements.referenceCanvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("CANVAS_UNAVAILABLE");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap.source, 0, 0, elements.referenceCanvas.width, elements.referenceCanvas.height);
      runtime.referenceReady = true;
      setState({ referenceName: file.name });
      setTimeout(() => {
        if (isCurrentSession(sessionRevision)) void runProcessing(sessionRevision);
      }, 30);
    } catch (error) {
      if (!isCurrentSession(sessionRevision)) return;
      console.error("未記入画像の読み込みに失敗しました。", error);
      setState({ error: friendlyError(error), phase: "error" });
    } finally {
      bitmap?.close();
    }
  }

  function removeReference() {
    const sessionRevision = beginSession();
    runtime.referenceReady = false;
    elements.referenceCanvas.width = 0;
    elements.referenceCanvas.height = 0;
    setState({ referenceName: "" });
    setTimeout(() => {
      if (isCurrentSession(sessionRevision)) void runProcessing(sessionRevision);
    }, 0);
  }

  async function loadSample() {
    const sessionRevision = beginSession();
    try {
      const response = await fetch(`./sample-worksheet.png?v=${ASSET_VERSION}`);
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const blob = await response.blob();
      if (!isCurrentSession(sessionRevision)) return;
      await loadFile(
        new File([blob], "漢字ミニテスト.png", { type: "image/png" }),
        true,
        sessionRevision,
      );
    } catch (error) {
      if (!isCurrentSession(sessionRevision)) return;
      console.error("サンプル画像を読み込めませんでした。", error);
      setState({ error: "サンプル画像を読み込めませんでした。", phase: "error" });
    }
  }

  function clearCanvas(canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }

  function clearAll() {
    beginSession();
    [elements.sourceCanvas, elements.resultCanvas, elements.printCanvas].forEach(clearCanvas);
    elements.referenceCanvas.width = 0;
    elements.referenceCanvas.height = 0;
    Object.assign(runtime, { referenceReady: false, editBase: null, editHistory: [], editRedo: [], currentStroke: null });
    Object.assign(state, {
      phase: "idle", fileName: "", referenceName: "", dimensions: null, sourceDimensions: null,
      error: "", editing: false, editTool: "erase", editCursor: null,
      editAvailability: { undo: false, redo: false }, zoom: 100, mobileDocument: null,
    });
    render();
  }

  function saveImage() {
    if (state.phase !== "complete") return;
    elements.resultCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const stem = state.fileName.replace(/\.[^.]+$/, "") || "cleaned-worksheet";
      link.href = url;
      link.download = `${stem}-clean.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }

  function rotateCanvasClockwise(canvas) {
    if (!canvas.width || !canvas.height) return;
    const buffer = document.createElement("canvas");
    buffer.width = canvas.width;
    buffer.height = canvas.height;
    const bufferContext = buffer.getContext("2d");
    const context = canvas.getContext("2d");
    if (!bufferContext || !context) return;
    bufferContext.drawImage(canvas, 0, 0);
    canvas.width = buffer.height;
    canvas.height = buffer.width;
    context.translate(canvas.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(buffer, 0, 0);
  }

  function rotateDocument() {
    if (state.phase !== "complete" || !elements.sourceCanvas.width || !elements.resultCanvas.width) return;
    rotateCanvasClockwise(elements.sourceCanvas);
    rotateCanvasClockwise(elements.resultCanvas);
    if (runtime.referenceReady) rotateCanvasClockwise(elements.referenceCanvas);
    if (state.dimensions) {
      state.dimensions = { width: state.dimensions.height, height: state.dimensions.width };
    }
    if (state.sourceDimensions) {
      state.sourceDimensions = { width: state.sourceDimensions.height, height: state.sourceDimensions.width };
    }
    const resultContext = elements.resultCanvas.getContext("2d", { willReadFrequently: true });
    runtime.editBase = resultContext?.getImageData(0, 0, elements.resultCanvas.width, elements.resultCanvas.height) || null;
    runtime.editHistory = [];
    runtime.editRedo = [];
    runtime.currentStroke = null;
    synchronizePrintCanvas();
    setState({ editing: false, editCursor: null, editAvailability: { undo: false, redo: false } });
  }

  function canvasPoint(event) {
    const rect = elements.resultCanvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * elements.resultCanvas.width,
      y: ((event.clientY - rect.top) / rect.height) * elements.resultCanvas.height,
      scale: elements.resultCanvas.width / rect.width,
    };
  }

  function updateEditCursor(event) {
    if (!state.editing) return;
    const rect = elements.resultSurface.getBoundingClientRect();
    state.editCursor = { left: event.clientX - rect.left, top: event.clientY - rect.top };
    renderEditCursor();
  }

  function clearEditCursor() {
    state.editCursor = null;
    renderEditCursor();
  }

  function drawEditSegment(canvas, stroke, from, to) {
    const context = canvas.getContext("2d");
    if (!context || (stroke.tool === "restore" && !elements.sourceCanvas)) return;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const size = Math.max(1, stroke.lineWidth);
    const half = size / 2;
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, size * 0.32)));
    context.save();
    context.fillStyle = "#ffffff";
    for (let step = 0; step <= steps; step += 1) {
      const progress = step / steps;
      const x = from.x + (to.x - from.x) * progress;
      const y = from.y + (to.y - from.y) * progress;
      const left = Math.max(0, Math.floor(x - half));
      const top = Math.max(0, Math.floor(y - half));
      const right = Math.min(canvas.width, Math.ceil(x + half));
      const bottom = Math.min(canvas.height, Math.ceil(y + half));
      const width = right - left, height = bottom - top;
      if (width <= 0 || height <= 0) continue;
      if (stroke.tool === "restore") {
        context.drawImage(elements.sourceCanvas, left, top, width, height, left, top, width, height);
      } else {
        context.fillRect(left, top, width, height);
      }
    }
    context.restore();
  }

  function replayEdits() {
    const context = elements.resultCanvas.getContext("2d");
    if (!runtime.editBase || !context) return;
    context.putImageData(runtime.editBase, 0, 0);
    for (const stroke of runtime.editHistory) {
      if (stroke.points.length === 1) drawEditSegment(elements.resultCanvas, stroke, stroke.points[0], stroke.points[0]);
      for (let index = 1; index < stroke.points.length; index += 1) {
        drawEditSegment(elements.resultCanvas, stroke, stroke.points[index - 1], stroke.points[index]);
      }
    }
    synchronizePrintCanvas();
  }

  function undoEdit() {
    const stroke = runtime.editHistory.pop();
    if (!stroke) return;
    runtime.editRedo.push(stroke);
    replayEdits();
    setState({ editAvailability: { undo: runtime.editHistory.length > 0, redo: true } });
  }

  function redoEdit() {
    const stroke = runtime.editRedo.pop();
    if (!stroke) return;
    runtime.editHistory.push(stroke);
    replayEdits();
    setState({ editAvailability: { undo: true, redo: runtime.editRedo.length > 0 } });
  }

  function startEdit(event) {
    if (!state.editing || state.phase !== "complete") return;
    updateEditCursor(event);
    elements.resultCanvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(event);
    const stroke = {
      tool: state.editTool,
      lineWidth: state.brushSize * point.scale,
      points: [{ x: point.x, y: point.y }],
    };
    runtime.currentStroke = stroke;
    runtime.editRedo = [];
    state.editAvailability = { undo: state.editAvailability.undo, redo: false };
    drawEditSegment(elements.resultCanvas, stroke, stroke.points[0], stroke.points[0]);
    render();
  }

  function moveEdit(event) {
    updateEditCursor(event);
    const stroke = runtime.currentStroke;
    if (!state.editing || !stroke) return;
    const point = canvasPoint(event);
    const previous = stroke.points[stroke.points.length - 1];
    const next = { x: point.x, y: point.y };
    stroke.points.push(next);
    drawEditSegment(elements.resultCanvas, stroke, previous, next);
  }

  function stopEdit() {
    const stroke = runtime.currentStroke;
    if (!stroke) return;
    runtime.editHistory.push(stroke);
    runtime.currentStroke = null;
    synchronizePrintCanvas();
    setState({ editAvailability: { undo: true, redo: false } });
  }

  function synchronizePreviewScroll(source, target) {
    if (!target || runtime.syncingScroll) return;
    runtime.syncingScroll = true;
    const sourceHorizontalRange = Math.max(0, source.scrollWidth - source.clientWidth);
    const sourceVerticalRange = Math.max(0, source.scrollHeight - source.clientHeight);
    const targetHorizontalRange = Math.max(0, target.scrollWidth - target.clientWidth);
    const targetVerticalRange = Math.max(0, target.scrollHeight - target.clientHeight);
    target.scrollLeft = sourceHorizontalRange ? (source.scrollLeft / sourceHorizontalRange) * targetHorizontalRange : 0;
    target.scrollTop = sourceVerticalRange ? (source.scrollTop / sourceVerticalRange) * targetVerticalRange : 0;
    if (runtime.scrollSyncFrame !== null) cancelAnimationFrame(runtime.scrollSyncFrame);
    runtime.scrollSyncFrame = requestAnimationFrame(() => {
      runtime.syncingScroll = false;
      runtime.scrollSyncFrame = null;
    });
  }

  function updateCorner(index, x, y) {
    if (!state.mobileDocument) return;
    const corners = state.mobileDocument.corners.map((corner) => ({ ...corner }));
    corners[index] = {
      x: Math.max(0.005, Math.min(0.995, x)),
      y: Math.max(0.005, Math.min(0.995, y)),
    };
    state.mobileDocument = { ...state.mobileDocument, corners };
    renderCorners();
  }

  function moveCorner(event, index) {
    if (!state.mobileDocument || state.mobileDocument.status !== "editing" || runtime.activeCorner !== index) return;
    const rect = elements.cropOverlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    updateCorner(index, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  }

  function bindEvents() {
    byId("brand-button").addEventListener("click", clearAll);
    // The initial picker is a native <label for="image-input">.  On iOS
    // standalone PWAs, a label keeps the user gesture intact even offline,
    // while an indirect input.click() may be ignored.
    byId("choose-image").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      elements.input.click();
    });
    byId("change-image").addEventListener("click", clearAll);
    document.querySelectorAll(".choose-another").forEach((button) => button.addEventListener("click", () => elements.input.click()));
    byId("load-sample").addEventListener("click", () => void loadSample());
    elements.input.addEventListener("change", (event) => {
      const [file] = [...(event.target.files || [])];
      if (file) void loadFile(file);
      event.target.value = "";
    });
    elements.referenceInput.addEventListener("change", (event) => {
      const [file] = [...(event.target.files || [])];
      if (file) void loadReferenceFile(file);
      event.target.value = "";
    });
    for (const name of ["dragenter", "dragover"]) {
      elements.dropZone.addEventListener(name, (event) => { event.preventDefault(); setState({ isDragging: true }); });
    }
    for (const name of ["dragleave", "dragend"]) {
      elements.dropZone.addEventListener(name, (event) => { event.preventDefault(); setState({ isDragging: false }); });
    }
    elements.dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      state.isDragging = false;
      const [file] = [...event.dataTransfer.files];
      if (file) void loadFile(file);
      else render();
    });

    elements.zoomFit.addEventListener("click", () => setState({ zoom: 100 }));
    elements.zoomControl.addEventListener("input", () => setState({ zoom: Number(elements.zoomControl.value) }));
    elements.editToolControl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-edit-tool]");
      if (button) setState({ editTool: button.dataset.editTool });
    });
    elements.cleaningMode.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (!button || button.disabled) return;
      const mode = button.dataset.mode;
      setState({ removeColor: mode !== "pencil", removePencil: mode !== "color" });
    });
    elements.editToggle.addEventListener("click", () => setState({ editing: !state.editing, editCursor: null }));
    elements.rotate.addEventListener("click", rotateDocument);
    elements.save.addEventListener("click", saveImage);
    elements.print.addEventListener("click", printResult);
    elements.brushSize.addEventListener("input", () => setState({ brushSize: Number(elements.brushSize.value) }));
    elements.undo.addEventListener("click", undoEdit);
    elements.redo.addEventListener("click", redoEdit);
    elements.strength.addEventListener("input", () => setState({ strength: Number(elements.strength.value) }));
    elements.reprocess.addEventListener("click", () => void runProcessing());
    elements.chooseReference.addEventListener("click", () => elements.referenceInput.click());
    byId("remove-reference").addEventListener("click", removeReference);
    elements.extract.addEventListener("click", () => void extractMobileDocument());
    elements.retry.addEventListener("click", () => void detectDocumentFromCanvas());
    elements.skip.addEventListener("click", () => void acceptOriginalMobilePhoto());
    elements.sourceStage.addEventListener("scroll", () => synchronizePreviewScroll(elements.sourceStage, elements.resultStage), { passive: true });
    elements.resultStage.addEventListener("scroll", () => synchronizePreviewScroll(elements.resultStage, elements.sourceStage), { passive: true });

    elements.resultCanvas.addEventListener("pointerdown", startEdit);
    elements.resultCanvas.addEventListener("pointerenter", updateEditCursor);
    elements.resultCanvas.addEventListener("pointermove", moveEdit);
    elements.resultCanvas.addEventListener("pointerup", stopEdit);
    elements.resultCanvas.addEventListener("pointercancel", stopEdit);
    elements.resultCanvas.addEventListener("pointerleave", clearEditCursor);

    [...elements.cropOverlay.querySelectorAll(".document-corner-handle")].forEach((handle, index) => {
      handle.addEventListener("pointerdown", (event) => {
        if (!state.mobileDocument || state.mobileDocument.status !== "editing") return;
        runtime.activeCorner = index;
        handle.setPointerCapture(event.pointerId);
        moveCorner(event, index);
      });
      handle.addEventListener("pointermove", (event) => moveCorner(event, index));
      const release = () => { runtime.activeCorner = null; };
      handle.addEventListener("pointerup", release);
      handle.addEventListener("pointercancel", release);
      handle.addEventListener("keydown", (event) => {
        if (!state.mobileDocument) return;
        const amount = event.shiftKey ? 0.01 : 0.003;
        const movement = { ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount] }[event.key];
        if (!movement) return;
        event.preventDefault();
        const corner = state.mobileDocument.corners[index];
        updateCorner(index, corner.x + movement[0], corner.y + movement[1]);
      });
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (state.editing) setState({ editing: false, editCursor: null });
        return;
      }
      if (!state.editing) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redoEdit() : undoEdit();
      } else if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoEdit();
      }
    });
    window.addEventListener("beforeprint", synchronizePrintCanvas);
    window.addEventListener("resize", scheduleCropPresentationSync, { passive: true });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register(`./sw.js?v=${ASSET_VERSION}`, {
      scope: "./",
      updateViaCache: "none",
    })
      .then((registration) => registration.update().catch(() => undefined))
      .catch((error) => console.warn("Service Worker の登録に失敗しました。", error));
  }

  bindEvents();
  initializeWorker();
  registerServiceWorker();
  render();
})();
