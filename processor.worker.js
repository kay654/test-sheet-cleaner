const PROCESSOR_PROTOCOL_VERSION = 1;

let resolveOpenCv;
let rejectOpenCv;
let openCvSettled = false;
let openCvPoll = null;
let openCvTimeout = null;

function reportStartup(stage, detail = "") {
  self.postMessage({
    type: "startup-progress",
    version: PROCESSOR_PROTOCOL_VERSION,
    stage,
    detail,
  });
}
const openCvReady = new Promise((resolve, reject) => {
  resolveOpenCv = resolve;
  rejectOpenCv = reject;
});

function finishOpenCv(candidate) {
  if (openCvSettled) return;
  const instance = candidate?.Mat
    ? candidate
    : self.cv?.Mat
      ? self.cv
      : self.Module?.Mat
        ? self.Module
        : null;
  if (!instance) return;
  openCvSettled = true;
  if (openCvPoll) clearInterval(openCvPoll);
  if (openCvTimeout) clearTimeout(openCvTimeout);
  reportStartup("opencv-ready");
  // OpenCV's Module object is thenable. Resolving a Promise with it directly
  // makes native Promise resolution adopt cv.then and can wait forever.
  resolveOpenCv({ instance });
}

self.Module = {
  locateFile(path) {
    const resolved = path.endsWith(".wasm")
      ? "./vendor/opencv/opencv.wasm"
      : path;
    reportStartup("wasm-locate", resolved);
    return resolved;
  },
  onRuntimeInitialized() {
    reportStartup("runtime-initialized");
    finishOpenCv(self.cv || self.Module);
  },
  postRun: [() => finishOpenCv(self.cv || self.Module)],
  onAbort(reason) {
    if (openCvSettled) return;
    openCvSettled = true;
    if (openCvPoll) clearInterval(openCvPoll);
    if (openCvTimeout) clearTimeout(openCvTimeout);
    rejectOpenCv(new Error(`OPENCV_JS_ABORTED:${String(reason || "unknown")}`));
  },
};

try {
  reportStartup("script-loading");
  importScripts("./vendor/opencv/opencv.js");
  reportStartup("script-loaded", typeof self.cv);
  if (self.cv && typeof self.cv.then === "function") {
    self.cv.then(finishOpenCv, rejectOpenCv);
  } else {
    finishOpenCv(self.cv);
  }
  if (!openCvSettled) {
    openCvPoll = setInterval(() => finishOpenCv(self.cv || self.Module), 50);
    openCvTimeout = setTimeout(() => {
      if (openCvSettled) return;
      openCvSettled = true;
      clearInterval(openCvPoll);
      rejectOpenCv(new Error("OPENCV_JS_INITIALIZATION_TIMEOUT"));
    }, 45_000);
  }
} catch (error) {
  openCvSettled = true;
  rejectOpenCv(error);
}

const modulesReady = Promise.all([
  import("./processing-core.js?v=1").then((module) => {
    reportStartup("core-loaded");
    return module;
  }),
  import("./opencv-processing.js?v=1").then((module) => {
    reportStartup("pipeline-loaded");
    return module;
  }),
  import("./document-scanner.js?v=1").then((module) => {
    reportStartup("scanner-loaded");
    return module;
  }),
  openCvReady,
]);

modulesReady
  .then(([, , , openCv]) => {
    reportStartup("all-ready");
    const cv = openCv.instance;
    const build = cv.getBuildInformation?.() || "";
    const version = build.match(/OpenCV\s+([\w.-]+)/)?.[1] || "5.0.0";
    self.postMessage({
      type: "ready",
      version: PROCESSOR_PROTOCOL_VERSION,
      engine: "opencv.js",
      openCvVersion: version,
    });
  })
  .catch((error) => {
    self.postMessage({
      type: "startup-error",
      version: PROCESSOR_PROTOCOL_VERSION,
      error: error instanceof Error ? error.message : "OPENCV_JS_LOAD_FAILED",
    });
  });

self.addEventListener("message", async (event) => {
  const { id, action = "clean", image, options } = event.data;
  try {
    const [core, processor, scanner, openCv] = await modulesReady;
    let result;
    if (action === "detect-document") {
      result = scanner.detectDocument(openCv.instance, image, options);
    } else if (action === "extract-document") {
      result = scanner.extractDocument(openCv.instance, image, options);
    } else if (action === "clean") {
      let inputMat = null;
      let outputMat = null;
      try {
        inputMat = new openCv.instance.Mat(image.height, image.width, openCv.instance.CV_8UC4);
        inputMat.data.set(image.data);
        outputMat = processor.processMatWithOpenCv(openCv.instance, core, inputMat, options);
        const pixels = options.suppressPaper !== false && !options.reference
          ? scanner.suppressPaperBackground(
            new Uint8ClampedArray(outputMat.data),
            outputMat.cols,
            outputMat.rows,
          )
          : new Uint8ClampedArray(outputMat.data);
        result = {
          data: pixels,
          width: outputMat.cols,
          height: outputMat.rows,
        };
      } finally {
        outputMat?.delete();
        inputMat?.delete();
      }
    } else {
      throw new Error("UNKNOWN_PROCESSOR_ACTION");
    }
    const transfers = result.data?.buffer ? [result.data.buffer] : [];
    self.postMessage(
      { id, ok: true, version: PROCESSOR_PROTOCOL_VERSION, result },
      transfers,
    );
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      version: PROCESSOR_PROTOCOL_VERSION,
      error: error instanceof Error ? error.message : "PROCESSING_FAILED",
    });
  }
});
