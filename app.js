import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import {
  fetchFile,
  toBlobURL,
} from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";
const { createWorker } = window.Tesseract;

const state = {
  sourceUrl: "",
  sourceType: "",
  sourceFile: null,
  sourceBytes: null,
  sourceExt: "mp4",
  duration: 0,
  width: 0,
  height: 0,
  segments: [],
  objectUrl: null,
  ffmpeg: null,
  ffmpegLoaded: false,
  ffmpegLoadingPromise: null,
  ffmpegInputName: "",
  ocrWorker: null,
  ocrLanguage: "",
  ocrLoadingPromise: null,
  logs: [],
};

const elements = {
  fileInput: document.querySelector("#fileInput"),
  urlInput: document.querySelector("#urlInput"),
  loadUrlBtn: document.querySelector("#loadUrlBtn"),
  videoPreview: document.querySelector("#videoPreview"),
  statusBadge: document.querySelector("#statusBadge"),
  videoMeta: document.querySelector("#videoMeta"),
  ffmpegBadge: document.querySelector("#ffmpegBadge"),
  ocrBadge: document.querySelector("#ocrBadge"),
  processingLog: document.querySelector("#processingLog"),
  loadFfmpegBtn: document.querySelector("#loadFfmpegBtn"),
  warmupOcrBtn: document.querySelector("#warmupOcrBtn"),
  analysisMode: document.querySelector("#analysisMode"),
  segmentLength: document.querySelector("#segmentLength"),
  videoTheme: document.querySelector("#videoTheme"),
  mainSubject: document.querySelector("#mainSubject"),
  visualStyle: document.querySelector("#visualStyle"),
  cameraRhythm: document.querySelector("#cameraRhythm"),
  moodTone: document.querySelector("#moodTone"),
  ocrLanguage: document.querySelector("#ocrLanguage"),
  promptMode: document.querySelector("#promptMode"),
  enableOcr: document.querySelector("#enableOcr"),
  extraNotes: document.querySelector("#extraNotes"),
  negativePrompt: document.querySelector("#negativePrompt"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  exportAllClipsBtn: document.querySelector("#exportAllClipsBtn"),
  regenerateBtn: document.querySelector("#regenerateBtn"),
  exportTxtBtn: document.querySelector("#exportTxtBtn"),
  exportJsonBtn: document.querySelector("#exportJsonBtn"),
  emptyState: document.querySelector("#emptyState"),
  segmentsContainer: document.querySelector("#segmentsContainer"),
  segmentTemplate: document.querySelector("#segmentTemplate"),
};

function setStatus(text, type = "idle") {
  elements.statusBadge.textContent = text;
  elements.statusBadge.className = `badge ${type}`;
}

function setEngineBadge(element, text, type = "idle") {
  element.textContent = text;
  element.className = `badge ${type}`;
}

function pushLog(message) {
  const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`;
  state.logs = [...state.logs.slice(-59), line];
  elements.processingLog.value = state.logs.join("\n");
  elements.processingLog.scrollTop = elements.processingLog.scrollHeight;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const mins = String(Math.floor(total / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatPreciseTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = String(Math.floor(safe / 60)).padStart(2, "0");
  const secs = (safe % 60).toFixed(1).padStart(4, "0");
  return `${mins}:${secs}`;
}

function formatRange(start, end) {
  return `${formatPreciseTime(start)}-${formatPreciseTime(end)}`;
}

function toChineseSegmentLabel(index) {
  const map = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  return `段落${map[index - 1] || index}`;
}

function escapeFilename(text) {
  return text.replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 40) || "seedance_prompts";
}

function guessExtension(name = "") {
  const matched = name.toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
  return matched?.[1] || "mp4";
}

function clearVideoSource() {
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
}

function resetSourceCache() {
  state.sourceBytes = null;
  state.ffmpegInputName = "";
  state.segments = [];
}

function loadVideoSource(url, sourceType, sourceFile = null) {
  state.sourceUrl = url;
  state.sourceType = sourceType;
  state.sourceFile = sourceFile;
  state.sourceExt = sourceFile?.name ? guessExtension(sourceFile.name) : guessExtension(url);
  state.duration = 0;
  state.width = 0;
  state.height = 0;
  resetSourceCache();
  renderSegments();
  elements.videoPreview.pause();
  elements.videoPreview.src = url;
  elements.videoPreview.load();
  setStatus("视频加载中", "idle");
  elements.videoMeta.textContent = "正在读取视频信息...";
}

function attachVideoEvents() {
  elements.videoPreview.addEventListener("loadedmetadata", () => {
    const duration = elements.videoPreview.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      setStatus("无法识别视频时长", "warn");
      elements.videoMeta.textContent = "请更换视频文件或直链";
      return;
    }

    state.duration = duration;
    state.width = elements.videoPreview.videoWidth || state.width;
    state.height = elements.videoPreview.videoHeight || state.height;
    const durationText = `${formatTime(duration)}（${Math.round(duration)} 秒）`;
    const sourceText = state.sourceType === "url" ? "链接导入" : "本地上传";
    elements.videoMeta.textContent = `${sourceText} | 总时长 ${durationText}`;

    if (duration > 120) {
      setStatus("超出 2 分钟限制", "warn");
    } else {
      setStatus("视频已就绪", "ok");
      pushLog(`视频已载入，来源：${sourceText}，总时长：${durationText}`);
    }
  });

  elements.videoPreview.addEventListener("error", () => {
    setStatus("视频加载失败", "warn");
    if (state.sourceType === "url") {
      elements.videoMeta.textContent =
        "该链接可能被跨域限制或不是可直接访问的视频直链，请优先使用本地上传。";
    } else {
      elements.videoMeta.textContent = "文件读取失败，请重新选择视频。";
    }
  });
}

function narrativeHint(index, total) {
  if (index === 0) {
    return {
      role: "开场建立段",
      scene: "交代环境、主角或产品首次出现，建立观众预期",
      action: "主体进入画面或完成一个清晰引入动作",
    };
  }

  if (index === total - 1) {
    return {
      role: "结尾收束段",
      scene: "强化记忆点，形成结束镜头或转化落点",
      action: "以停留、展示结果或品牌记忆点收尾",
    };
  }

  const progress = index / Math.max(total - 1, 1);

  if (progress < 0.45) {
    return {
      role: "信息展开段",
      scene: "补充核心细节，展示使用方式或情绪推进",
      action: "通过连续动作或近景细节强化主体价值",
    };
  }

  if (progress < 0.8) {
    return {
      role: "高潮强化段",
      scene: "让画面节奏更饱满，突出变化、反应或结果",
      action: "增加动作幅度、镜头变化和视觉冲击",
    };
  }

  return {
    role: "过渡承接段",
    scene: "衔接前后段落，保证故事或展示逻辑顺畅",
    action: "使用自然转场或主体连续动作完成过渡",
  };
}

function promptModeHint(mode) {
  const map = {
    广告转化: "突出卖点、质感、情绪转化和结尾行动感",
    剧情分镜: "强调镜头衔接、人物状态、叙事推进与情绪层次",
    "Vlog 记录": "强调真实感、生活气息、自然跟拍和轻节奏",
    产品演示: "强调产品特写、功能动作、材质光泽和使用场景",
  };
  return map[mode] || "保证画面具体、可执行、适合 15 秒视频生成";
}

function sanitizeOcrText(text = "") {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const usefulChars = normalized.match(/[\u4e00-\u9fa5A-Za-z0-9]/g) || [];
  if (!usefulChars.length) return "";
  if (usefulChars.length < 4) return "";
  return normalized.slice(0, 32);
}

function inferShotVisual(shot, segment, position) {
  const text = sanitizeOcrText(shot.ocrText);
  if (text.includes("普通") || text.includes("发黄") || text.includes("发脏")) {
    return "普通旧杯子内部发黄发脏的对比画面，突出容易藏污纳垢。";
  }
  if (text.includes("加厚") || text.includes("沉甸")) {
    return "产品近景特写，重点展示杯身厚度、材质和整体分量感。";
  }
  if (text.includes("放心冲")) {
    return "整洁洗手台和收纳完成后的使用场景，作为结尾转化画面。";
  }
  if (text.includes("品质") || text.includes("颜值")) {
    return "多色产品同框摆放，突出整体陈列效果和家居搭配感。";
  }
  if (text.includes("健康环保")) {
    return "产品上手展示镜头，突出主体颜色、外观和干净清爽的第一眼质感。";
  }
  if (position === 0) {
    return "开场环境镜头，先交代桌面或使用场景，再把注意力引到主体上。";
  }
  if (position === segment.shots.length - 1) {
    return "收尾镜头，保留主体最终展示或使用后的整洁状态，形成结束感。";
  }
  if (shot.end - shot.start > 3.5) {
    return "主体持续展示镜头，突出产品外观、摆放状态或使用场景。";
  }
  return "承接前后内容的产品展示镜头，保持与原视频一致的画面顺序。";
}

function inferShotCameraMotion(shot, position) {
  const duration = shot.end - shot.start;
  if (duration < 1) {
    return "快切插入镜头，短暂停留后立即切到下一个画面。";
  }
  if (duration < 2.2) {
    return "近景停留或轻微推近，节奏紧凑。";
  }
  if (position === 0) {
    return "轻微推进，先交代环境再进入主体。";
  }
  if (position > 0 && duration > 3.5) {
    return "中景到近景的稳定展示，保留原片节奏，不做夸张运镜。";
  }
  return "中近景平稳展示，镜头自然承接前后镜头。";
}

function inferShotVoiceover(shot, position, segment) {
  const text = sanitizeOcrText(shot.ocrText);
  if (text.includes("不是好看的我不用")) return "不是好看的我不用。";
  if (text.includes("健康环保")) return "这种牙刷杯我一眼就看中了，颜色和质感都特别舒服。";
  if (text.includes("普通") || text.includes("发黄") || text.includes("发脏")) {
    return "普通的那种杯子用不了多久，里面就开始发黄发脏。";
  }
  if (text.includes("不管你用多久")) return "不管你用多久，看着都更干净，也更省心。";
  if (text.includes("加厚") || text.includes("沉甸")) return "加厚的杯身，拿着就是沉甸甸的。";
  if (text.includes("颜值") || text.includes("品质")) return "这颜值，这个品质，成套摆着真的特别舒服。";
  if (text.includes("放心冲")) return "好看、耐用、还实用，姐妹们真的可以放心冲。";
  if (position === 0) return "先把开场氛围立住，再把注意力引到主体上。";
  if (position === segment.shots.length - 1) return "这一镜负责把这一段自然收住。";
  return "延续上一镜头的展示逻辑，把卖点继续往下讲。";
}

function buildShotScript(shot, segment, position) {
  const visual = inferShotVisual(shot, segment, position);
  const cameraMotion = inferShotCameraMotion(shot, position);
  const voiceover = inferShotVoiceover(shot, position, segment);
  return {
    index: shot.index,
    time: formatRange(shot.start, shot.end),
    visual,
    cameraMotion,
    voiceover,
  };
}

function buildSegmentBreakdown(segment) {
  return segment.shotScripts
    .map(
      (shot) =>
        `镜头${shot.index}\n时间：${shot.time}\n画面：${shot.visual}\n镜头运动：${shot.cameraMotion}\n旁白：${shot.voiceover}`,
    )
    .join("\n\n");
}

function buildSegmentVisualSummary(segment) {
  return segment.shotScripts.map((shot, idx) => `${idx + 1}. ${shot.visual}`).join("\n");
}

function buildSegmentCameraSummary(segment) {
  return segment.shotScripts.map((shot, idx) => `${idx + 1}. ${shot.cameraMotion}`).join("\n");
}

function buildSegmentVoiceoverSummary(segment) {
  return segment.shotScripts.map((shot) => shot.voiceover).join("");
}

function getAnalysisConfig() {
  const mode = elements.analysisMode?.value || "fast";
  return {
    mode,
    maxSegmentSeconds: Math.min(15, Math.max(5, Number(elements.segmentLength.value) || 15)),
    runOcr: mode === "detail" ? elements.enableOcr.checked : false,
    sampleEveryShot: mode === "detail",
    maxSampledShotsPerChunk: mode === "detail" ? 6 : 2,
  };
}

function selectSampledShotIndexes(seedanceChunks, config) {
  const indexes = new Set();

  for (const chunk of seedanceChunks) {
    const shots = chunk.shots;
    if (!shots.length) continue;

    if (config.sampleEveryShot) {
      shots.forEach((shot) => indexes.add(shot.index));
      continue;
    }

    indexes.add(shots[0].index);
    if (shots.length > 2) {
      indexes.add(shots[Math.floor(shots.length / 2)].index);
    }
    if (shots.length > 1) {
      indexes.add(shots[shots.length - 1].index);
    }
  }

  return indexes;
}

function buildPrompt(segment) {
  return buildSeedanceCopyText(segment, { includeLabel: true });
}

function buildSeedanceCopyText(segment, options = {}) {
  const { includeLabel = true, includeShotRange = false } = options;
  const label = toChineseSegmentLabel(segment.index);
  const lines = [
    ...(includeLabel ? [label] : []),
    `时间：${formatRange(segment.start, segment.end)}`,
    ...(includeShotRange
      ? [
          `包含镜头：${segment.shotScripts[0]?.index || 1}-${segment.shotScripts.at(-1)?.index || segment.shotScripts.length}`,
        ]
      : []),
    "画面：",
    segment.scene,
    "镜头运动：",
    segment.camera,
    "旁白：",
    segment.action,
  ];
  return lines.join("\n");
}

function updateSegmentPrompt(segment, card) {
  segment.role = card.querySelector(".segment-role").value.trim();
  segment.shotBreakdown = card.querySelector(".segment-breakdown").value.trim();
  segment.scene = card.querySelector(".segment-scene").value.trim();
  segment.action = card.querySelector(".segment-action").value.trim();
  segment.ocrText = card.querySelector(".segment-ocr").value.trim();
  segment.camera = card.querySelector(".segment-camera").value.trim();
  segment.prompt = buildPrompt(segment);
  card.querySelector(".segment-prompt").value = segment.prompt;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadText(content, filename, type) {
  downloadBlob(new Blob([content], { type }), filename);
}

async function ensureFFmpegLoaded() {
  if (state.ffmpegLoaded && state.ffmpeg) return state.ffmpeg;
  if (state.ffmpegLoadingPromise) return state.ffmpegLoadingPromise;

  setEngineBadge(elements.ffmpegBadge, "加载中", "idle");
  pushLog("开始加载 FFmpeg.wasm 核心资源...");

  state.ffmpeg ??= new FFmpeg();
  state.ffmpeg.on("log", ({ message }) => {
    if (message) pushLog(`FFmpeg: ${message}`);
  });
  state.ffmpeg.on("progress", ({ progress }) => {
    const percent = Math.min(100, Math.max(0, Math.round(progress * 100)));
    if (percent) pushLog(`FFmpeg 处理进度：${percent}%`);
  });

  state.ffmpegLoadingPromise = (async () => {
    const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
    await state.ffmpeg.load({
      classWorkerURL: `${window.location.origin}/vendor/ffmpeg/worker.js`,
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });
    state.ffmpegLoaded = true;
    setEngineBadge(elements.ffmpegBadge, "已加载", "ok");
    pushLog("FFmpeg.wasm 已就绪。");
    return state.ffmpeg;
  })().catch((error) => {
    setEngineBadge(elements.ffmpegBadge, "加载失败", "warn");
    pushLog(`FFmpeg 加载失败：${error.message}`);
    throw error;
  }).finally(() => {
    state.ffmpegLoadingPromise = null;
  });

  return state.ffmpegLoadingPromise;
}

async function ensureOCRWorker() {
  const nextLanguage = elements.ocrLanguage.value;

  if (state.ocrWorker && state.ocrLanguage === nextLanguage) {
    return state.ocrWorker;
  }

  if (state.ocrLoadingPromise) {
    return state.ocrLoadingPromise;
  }

  if (state.ocrWorker) {
    await state.ocrWorker.terminate();
    state.ocrWorker = null;
  }

  setEngineBadge(elements.ocrBadge, "加载中", "idle");
  pushLog(`开始加载 OCR 语言模型：${nextLanguage}`);

  state.ocrLoadingPromise = createWorker(nextLanguage)
    .then((worker) => {
      state.ocrWorker = worker;
      state.ocrLanguage = nextLanguage;
      setEngineBadge(elements.ocrBadge, "已加载", "ok");
      pushLog(`OCR 已就绪，当前语言：${nextLanguage}`);
      return worker;
    })
    .catch((error) => {
      setEngineBadge(elements.ocrBadge, "加载失败", "warn");
      pushLog(`OCR 加载失败：${error.message}`);
      throw error;
    })
    .finally(() => {
      state.ocrLoadingPromise = null;
    });

  return state.ocrLoadingPromise;
}

async function ensureSourceBytes() {
  if (state.sourceBytes) {
    return {
      bytes: state.sourceBytes,
      inputName: state.ffmpegInputName,
    };
  }

  let payload;

  if (state.sourceFile) {
    pushLog(`正在读取本地视频文件：${state.sourceFile.name}`);
    payload = await fetchFile(state.sourceFile);
  } else if (state.sourceType === "url") {
    pushLog("正在尝试抓取视频直链资源...");
    const response = await fetch(state.sourceUrl);
    if (!response.ok) {
      throw new Error("无法下载该视频链接，请改用本地上传或确保链接允许跨域访问。");
    }
    const blob = await response.blob();
    payload = await fetchFile(blob);
    state.sourceExt = guessExtension(state.sourceUrl) || "mp4";
  } else {
    throw new Error("没有可用的视频源。");
  }

  state.sourceBytes = new Uint8Array(payload);
  state.ffmpegInputName = `input.${state.sourceExt || "mp4"}`;
  return {
    bytes: state.sourceBytes,
    inputName: state.ffmpegInputName,
  };
}

async function ensureFFmpegInputPrepared() {
  const ffmpeg = await ensureFFmpegLoaded();
  const { bytes, inputName } = await ensureSourceBytes();

  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(bytes));
    pushLog(`已写入 FFmpeg 文件系统：${inputName}`);
  } catch (error) {
    pushLog(`重新写入输入文件：${inputName}`);
    await ffmpeg.writeFile(inputName, new Uint8Array(bytes));
  }

  return { ffmpeg, inputName };
}

function parseDurationText(raw) {
  const matched = raw.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!matched) return 0;
  const hours = Number(matched[1] || 0);
  const minutes = Number(matched[2] || 0);
  const seconds = Number(matched[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function parseVideoSize(raw) {
  const matched = raw.match(/Video:.*?(\d{2,5})x(\d{2,5})[\s,\[]/);
  if (!matched) return { width: 0, height: 0 };
  return {
    width: Number(matched[1] || 0),
    height: Number(matched[2] || 0),
  };
}

async function ensureVideoMetadata() {
  if (state.duration > 0) {
    return {
      duration: state.duration,
      width: state.width,
      height: state.height,
    };
  }

  pushLog("浏览器未返回元数据，改用 FFmpeg 探测视频信息...");
  const { ffmpeg, inputName } = await ensureFFmpegInputPrepared();
  const logs = [];
  const captureLog = ({ message }) => {
    if (message) logs.push(message);
  };

  ffmpeg.on("log", captureLog);
  try {
    await ffmpeg.exec(["-i", inputName]);
  } catch {
    // ffmpeg 仅探测输入时通常会以非 0 退出，日志里仍能拿到元数据
  } finally {
    ffmpeg.off("log", captureLog);
  }

  const raw = logs.join("\n");
  const duration = parseDurationText(raw);
  const { width, height } = parseVideoSize(raw);

  if (duration > 0) {
    state.duration = duration;
  }

  if (width > 0 && height > 0) {
    state.width = width;
    state.height = height;
  }

  if (!state.duration) {
    throw new Error("无法识别视频时长，请更换文件或稍后再试。");
  }

  const sourceText = state.sourceType === "url" ? "链接导入" : "本地上传";
  const durationText = `${formatTime(state.duration)}（${Math.round(state.duration)} 秒）`;
  elements.videoMeta.textContent = `${sourceText} | 总时长 ${durationText}`;
  setStatus("视频已就绪", "ok");
  pushLog(`FFmpeg 探测成功：${durationText}${state.width && state.height ? `，分辨率 ${state.width}x${state.height}` : ""}`);

  return {
    duration: state.duration,
    width: state.width,
    height: state.height,
  };
}

function parseShotTimesFromLogs(raw) {
  const matches = [...raw.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)];
  return matches.map((match) => Number(match[1]));
}

function dedupeAndNormalizeShotTimes(times, duration, minGap = 0.8) {
  const result = [];
  for (const time of times) {
    if (!Number.isFinite(time)) continue;
    if (time <= minGap || time >= duration - minGap) continue;
    const prev = result[result.length - 1];
    if (prev == null || Math.abs(time - prev) >= minGap) {
      result.push(time);
    }
  }
  return result;
}

async function detectOriginalShotBoundaries() {
  const { ffmpeg, inputName } = await ensureFFmpegInputPrepared();
  const logs = [];
  const captureLog = ({ message }) => {
    if (message) logs.push(message);
  };
  ffmpeg.on("log", captureLog);

  try {
    await ffmpeg.exec([
      "-i",
      inputName,
      "-filter:v",
      "select='gt(scene,0.25)',showinfo",
      "-vsync",
      "vfr",
      "-f",
      "null",
      "-",
    ]);
  } catch {
    // scene detect 常以非零退出，日志仍然可用
  } finally {
    ffmpeg.off("log", captureLog);
  }

  const raw = logs.join("\n");
  const times = parseShotTimesFromLogs(raw);
  const boundaries = dedupeAndNormalizeShotTimes(times, state.duration);
  pushLog(`原镜头检测完成，识别到 ${boundaries.length + 1} 个镜头段。`);
  return boundaries;
}

function summarizeShot(shot) {
  const parts = [`镜头${shot.index}`];
  parts.push(`${formatRange(shot.start, shot.end)}`);
  if (shot.ocrText) {
    parts.push(`画面字样：${shot.ocrText}`);
  } else {
    parts.push("画面字样：无明显可识别文字");
  }
  return parts.join(" | ");
}

function summarizeChunkScene(shots) {
  return shots
    .map((shot, idx) => `${idx + 1}. ${inferShotVisual(shot, { shots }, idx)}`)
    .join("\n");
}

function summarizeChunkAction(shots) {
  return shots
    .map((shot, idx) => inferShotVoiceover(shot, idx, { shots }))
    .join("");
}

function buildShotsFromBoundaries(boundaries) {
  const times = [0, ...boundaries, state.duration];
  const shots = [];

  for (let index = 0; index < times.length - 1; index += 1) {
    const start = times[index];
    const end = times[index + 1];
    if (end - start < 0.3) continue;
    shots.push({
      index: shots.length + 1,
      start,
      end,
      thumb: "",
      ocrText: "",
    });
  }

  return shots;
}

function packageShotsForSeedance(shots, maxDuration) {
  const chunks = [];
  let current = [];
  let currentStart = 0;
  let currentEnd = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      index: chunks.length + 1,
      shots: current,
      start: currentStart,
      end: currentEnd,
    });
    current = [];
  };

  for (const shot of shots) {
    const shotDuration = shot.end - shot.start;
    if (shotDuration > maxDuration) {
      flush();
      let start = shot.start;
      while (start < shot.end - 0.01) {
        const end = Math.min(start + maxDuration, shot.end);
        chunks.push({
          index: chunks.length + 1,
          shots: [
            {
              ...shot,
              start,
              end,
            },
          ],
          start,
          end,
        });
        start = end;
      }
      continue;
    }

    if (!current.length) {
      current = [shot];
      currentStart = shot.start;
      currentEnd = shot.end;
      continue;
    }

    if (shot.end - currentStart <= maxDuration) {
      current.push(shot);
      currentEnd = shot.end;
    } else {
      flush();
      current = [shot];
      currentStart = shot.start;
      currentEnd = shot.end;
    }
  }

  flush();
  return chunks;
}

async function generateThumbnail(time, index) {
  try {
    const { ffmpeg, inputName } = await ensureFFmpegInputPrepared();
    const safeTime = Math.max(0, time);
    const outputName = `thumb_${index}_${Math.round(safeTime * 1000)}.jpg`;

    try {
      await ffmpeg.deleteFile(outputName);
    } catch {
      // ignore
    }

    await ffmpeg.exec([
      "-ss",
      safeTime.toFixed(3),
      "-i",
      inputName,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-q:v",
      "2",
      outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const blob = new Blob([bytes.buffer], { type: "image/jpeg" });
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result || "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    pushLog(`第 ${index} 段缩略图提取失败：${error.message}`);
    return "";
  }
}

async function recognizeTextFromImage(imageDataUrl, index) {
  if (!imageDataUrl) return "";

  const worker = await ensureOCRWorker();
  pushLog(`开始识别第 ${index} 段关键帧文字...`);
  const result = await worker.recognize(imageDataUrl);
  const text = result?.data?.text?.replace(/\s+/g, " ").trim() || "";
  pushLog(`第 ${index} 段 OCR 完成${text ? `：${text.slice(0, 30)}` : "，未识别到明显文字"}`);
  return text;
}

async function buildSegments() {
  const config = getAnalysisConfig();
  const segmentLength = config.maxSegmentSeconds;

  if (!state.sourceUrl) {
    alert("请先导入视频。");
    return;
  }

  try {
    await ensureVideoMetadata();
  } catch (error) {
    alert(error.message);
    return;
  }

  if (state.duration > 120) {
    alert("当前视频超过 2 分钟，分享版暂不支持处理。");
    return;
  }

  setStatus("生成分段中", "idle");
  elements.emptyState.textContent = "正在按原镜头分析、抽帧、OCR 并打包为 Seedance 段，请稍候...";
  pushLog(
    `开始分析原视频镜头，再按不超过 ${segmentLength}s 打包为 Seedance 段...当前模式：${
      config.mode === "detail" ? "精细模式" : "极速模式"
    }`,
  );

  const shouldRunOcr = config.runOcr;

  if (shouldRunOcr) {
    try {
      await ensureOCRWorker();
    } catch (error) {
      pushLog(`OCR 预加载失败，跳过文字识别：${error.message}`);
    }
  }

  const boundaries = await detectOriginalShotBoundaries();
  const shots = buildShotsFromBoundaries(boundaries);

  const seedanceChunks = packageShotsForSeedance(shots, segmentLength);
  const sampledShotIndexes = selectSampledShotIndexes(seedanceChunks, config);

  for (const shot of shots) {
    if (!sampledShotIndexes.has(shot.index)) continue;
    const middle = Math.min(shot.start + (shot.end - shot.start) / 2, state.duration - 0.2);
    shot.thumb = await generateThumbnail(middle, shot.index);
    if (shouldRunOcr && state.ocrWorker) {
      try {
        shot.ocrText = await recognizeTextFromImage(shot.thumb, shot.index);
      } catch (error) {
        pushLog(`镜头 ${shot.index} OCR 失败：${error.message}`);
      }
    }
  }

  const results = [];

  for (let index = 0; index < seedanceChunks.length; index += 1) {
    const chunk = seedanceChunks[index];
    const hint = narrativeHint(index, seedanceChunks.length);
    const firstThumb = chunk.shots.find((shot) => shot.thumb)?.thumb || "";
    const mergedOcr = [...new Set(chunk.shots.map((shot) => shot.ocrText).filter(Boolean))].join("；");
    const shotBreakdown = chunk.shots.map((shot) => summarizeShot(shot)).join("\n");

    const segment = {
      id: `segment-${index + 1}`,
      index: index + 1,
      start: chunk.start,
      end: chunk.end,
      thumb: firstThumb,
      shots: chunk.shots,
      role: hint.role,
      shotBreakdown,
      scene: summarizeChunkScene(chunk.shots),
      action: summarizeChunkAction(chunk.shots),
      ocrText: mergedOcr,
      shotScripts: chunk.shots.map((shot, idx) => buildShotScript(shot, { shots: chunk.shots }, idx)),
      camera: "",
      prompt: "",
    };

    segment.shotBreakdown = buildSegmentBreakdown(segment);
    segment.scene = buildSegmentVisualSummary(segment);
    segment.camera = buildSegmentCameraSummary(segment);
    segment.action = buildSegmentVoiceoverSummary(segment);

    results.push({
      ...segment,
      prompt: buildPrompt(segment),
    });
  }

  state.segments = results;
  renderSegments();
  setStatus("拆段完成", "ok");
  elements.videoMeta.textContent = `${state.sourceType === "url" ? "链接导入" : "本地上传"} | 总时长 ${formatTime(state.duration)} | 原镜头 ${shots.length} 个 | Seedance 段 ${state.segments.length} 个`;
  pushLog(
    `原镜头分析完成：共 ${shots.length} 个原镜头，已打包为 ${state.segments.length} 个 Seedance 段。本次实际抽帧 ${sampledShotIndexes.size} 个。`,
  );
}

async function exportSegmentClip(segment, button) {
  if (!state.sourceUrl || !state.duration) {
    alert("请先导入视频。");
    return;
  }

  const filenameBase = escapeFilename(
    `${elements.videoTheme.value.trim() || "seedance"}_segment_${segment.index}`,
  );

  const originalText = button?.textContent;
  if (button) button.textContent = "导出中...";

  try {
    setStatus(`导出第 ${segment.index} 段`, "idle");
    pushLog(`开始导出第 ${segment.index} 段 MP4...`);
    const { ffmpeg, inputName } = await ensureFFmpegInputPrepared();
    const outputName = `${filenameBase}.mp4`;
    const duration = Math.max(0.1, segment.end - segment.start).toFixed(3);
    const start = Math.max(0, segment.start).toFixed(3);

    try {
      await ffmpeg.exec([
        "-ss",
        start,
        "-t",
        duration,
        "-i",
        inputName,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "28",
        "-c:a",
        "aac",
        "-movflags",
        "faststart",
        outputName,
      ]);
    } catch (error) {
      pushLog(`H.264 导出失败，尝试使用 copy 模式回退：${error.message}`);
      await ffmpeg.exec([
        "-ss",
        start,
        "-t",
        duration,
        "-i",
        inputName,
        "-c",
        "copy",
        outputName,
      ]);
    }

    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    downloadBlob(new Blob([bytes.buffer], { type: "video/mp4" }), outputName);
    pushLog(`第 ${segment.index} 段导出完成：${outputName}`);
    setStatus("切片导出完成", "ok");
  } catch (error) {
    console.error(error);
    pushLog(`导出失败：${error.message}`);
    setStatus("切片导出失败", "warn");
    alert(`第 ${segment.index} 段导出失败：${error.message}`);
  } finally {
    if (button) button.textContent = originalText;
  }
}

async function exportAllClips() {
  if (!state.segments.length) {
    alert("请先生成拆段结果。");
    return;
  }

  elements.exportAllClipsBtn.disabled = true;
  const originalText = elements.exportAllClipsBtn.textContent;
  elements.exportAllClipsBtn.textContent = "批量导出中...";

  try {
    for (const segment of state.segments) {
      await exportSegmentClip(segment);
    }
  } finally {
    elements.exportAllClipsBtn.disabled = false;
    elements.exportAllClipsBtn.textContent = originalText;
  }
}

function renderSegments() {
  elements.segmentsContainer.innerHTML = "";

  if (!state.segments.length) {
    elements.emptyState.hidden = false;
    return;
  }

  elements.emptyState.hidden = true;

  state.segments.forEach((segment) => {
    const fragment = elements.segmentTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".segment-card");
    const title = fragment.querySelector(".segment-title");
    const time = fragment.querySelector(".segment-time");
    const thumb = fragment.querySelector(".segment-thumb");
    const roleInput = fragment.querySelector(".segment-role");
    const breakdownInput = fragment.querySelector(".segment-breakdown");
    const sceneInput = fragment.querySelector(".segment-scene");
    const actionInput = fragment.querySelector(".segment-action");
    const ocrInput = fragment.querySelector(".segment-ocr");
    const cameraInput = fragment.querySelector(".segment-camera");
    const promptOutput = fragment.querySelector(".segment-prompt");
    const copyBtn = fragment.querySelector(".copy-btn");
    const refreshBtn = fragment.querySelector(".refresh-btn");
    const downloadBtn = fragment.querySelector(".download-btn");

    title.textContent = `第 ${segment.index} 段`;
    time.textContent = `${formatRange(segment.start, segment.end)} | 镜头 ${segment.shotScripts[0]?.index || 1}-${segment.shotScripts.at(-1)?.index || segment.shotScripts.length}`;
    thumb.src =
      segment.thumb ||
      "data:image/svg+xml;charset=UTF-8," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#111827"/><text x="50%" y="50%" fill="#94a3b8" font-size="24" text-anchor="middle" dominant-baseline="middle">无法提取缩略图</text></svg>`,
        );

    roleInput.value = segment.role;
    breakdownInput.value = segment.shotBreakdown || "";
    sceneInput.value = segment.scene;
    actionInput.value = segment.action;
    ocrInput.value = segment.ocrText || "";
    cameraInput.value = segment.camera;
    promptOutput.value = segment.prompt;

    [roleInput, breakdownInput, sceneInput, actionInput, ocrInput, cameraInput].forEach((input) => {
      input.addEventListener("input", () => updateSegmentPrompt(segment, card));
    });

    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(buildSeedanceCopyText(segment, { includeLabel: true }));
      copyBtn.textContent = "已复制";
      setTimeout(() => {
        copyBtn.textContent = "复制本段 Prompt";
      }, 1200);
    });

    refreshBtn.addEventListener("click", () => updateSegmentPrompt(segment, card));
    downloadBtn.addEventListener("click", () => exportSegmentClip(segment, downloadBtn));
    elements.segmentsContainer.appendChild(fragment);
  });
}

function regenerateAll() {
  if (!state.segments.length) {
    alert("请先生成拆段结果。");
    return;
  }

  state.segments = state.segments.map((segment, index) => {
    const hint = narrativeHint(index, state.segments.length);
    const nextSegment = {
      ...segment,
      role: segment.role || hint.role,
      scene: segment.scene || hint.scene,
      action: segment.action || hint.action,
    };
    return {
      ...nextSegment,
      prompt: buildPrompt(nextSegment),
    };
  });

  renderSegments();
  setStatus("Prompt 已更新", "ok");
  pushLog("已重新生成全部 Prompt。");
}

function exportTxt() {
  if (!state.segments.length) {
    alert("暂无可导出的内容。");
    return;
  }

  const title = escapeFilename(elements.videoTheme.value.trim() || "seedance_prompts");
  const text = state.segments
    .map(
      (segment) =>
        `${buildSeedanceCopyText(segment, { includeLabel: true, includeShotRange: true })}\n\n逐镜头：\n${segment.shotBreakdown}`,
    )
    .join("\n\n");

  downloadText(text, `${title}.txt`, "text/plain;charset=utf-8");
}

function exportJson() {
  if (!state.segments.length) {
    alert("暂无可导出的内容。");
    return;
  }

  const title = escapeFilename(elements.videoTheme.value.trim() || "seedance_prompts");
  const json = JSON.stringify(
    {
      meta: {
        sourceType: state.sourceType,
        duration: state.duration,
        segmentLength: Number(elements.segmentLength.value) || 15,
        theme: elements.videoTheme.value.trim(),
        subject: elements.mainSubject.value.trim(),
        visualStyle: elements.visualStyle.value,
        cameraRhythm: elements.cameraRhythm.value,
        moodTone: elements.moodTone.value,
        ocrLanguage: elements.ocrLanguage.value,
        promptMode: elements.promptMode.value,
      },
      segments: state.segments.map((segment) => ({
        index: segment.index,
        label: toChineseSegmentLabel(segment.index),
        time: formatRange(segment.start, segment.end),
        shot_range: `${segment.shotScripts[0]?.index || 1}-${segment.shotScripts.at(-1)?.index || segment.shotScripts.length}`,
        visuals: segment.scene,
        camera_motion: segment.camera,
        voiceover: segment.action,
        prompt: buildSeedanceCopyText(segment, { includeLabel: true }),
        copy_prompt: buildSeedanceCopyText(segment, { includeLabel: false }),
        shots: segment.shotScripts,
      })),
    },
    null,
    2,
  );

  downloadText(json, `${title}.json`, "application/json;charset=utf-8");
}

function bindEvents() {
  elements.fileInput.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    if (!file) return;
    clearVideoSource();
    const objectUrl = URL.createObjectURL(file);
    state.objectUrl = objectUrl;
    loadVideoSource(objectUrl, "file", file);
  });

  elements.loadUrlBtn.addEventListener("click", () => {
    const url = elements.urlInput.value.trim();
    if (!url) {
      alert("请先输入视频链接。");
      return;
    }

    clearVideoSource();
    loadVideoSource(url, "url");
  });

  elements.loadFfmpegBtn.addEventListener("click", async () => {
    try {
      await ensureFFmpegLoaded();
    } catch (error) {
      alert(`FFmpeg 加载失败：${error.message}`);
    }
  });

  elements.warmupOcrBtn.addEventListener("click", async () => {
    try {
      await ensureOCRWorker();
    } catch (error) {
      alert(`OCR 加载失败：${error.message}`);
    }
  });

  elements.analyzeBtn.addEventListener("click", buildSegments);
  elements.exportAllClipsBtn.addEventListener("click", exportAllClips);
  elements.regenerateBtn.addEventListener("click", regenerateAll);
  elements.exportTxtBtn.addEventListener("click", exportTxt);
  elements.exportJsonBtn.addEventListener("click", exportJson);
}

attachVideoEvents();
bindEvents();
pushLog("页面已加载，可先导入 2 分钟内视频，再生成拆段结果。");

window.__seedance = {
  state,
  elements,
  loadVideoSource,
  buildSegments,
  ensureFFmpegLoaded,
  ensureOCRWorker,
  exportAllClips,
};
