const NON_RETRYABLE_RECOGNITION_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "audio-capture"
]);

export class BrowserVoiceConversation {
  constructor({ language = "zh-CN", onTranscript, onStatus, logger } = {}) {
    this.language = language || "zh-CN";
    this.onTranscript = onTranscript;
    this.onStatus = onStatus;
    this.logger = logger;
    this.recognition = null;
    this.listening = false;
    this.speaking = false;
    this.lastTranscript = "";
    this.lastReply = "";
    this.lastError = "";
    this.speechToken = 0;
    this.cachedVoices = [];
    this.preferredVoice = null;
    this.loadVoices();
  }

  // 加载系统语音列表并选中文字音。Chrome 的 getVoices() 异步，必须监听 voiceschanged
  loadVoices() {
    if (!this.isSpeechSupported()) return;
    const sync = () => {
      this.cachedVoices = globalThis.speechSynthesis.getVoices() || [];
      const langPrefix = this.language.split("-")[0]; // "zh"
      // 优先神经音（Online/Natural），其次任意中文音
      this.preferredVoice =
        this.cachedVoices.find(v => /\b(zh|chinese|中文)\b/i.test(`${v.lang} ${v.name}`) && /natural|online|xiaoxiao|yunxi|huihui|yaoyao/i.test(v.name)) ||
        this.cachedVoices.find(v => new RegExp(`^${langPrefix}`).test(v.lang)) ||
        this.cachedVoices.find(v => /\b(zh|chinese)\b/i.test(v.lang)) ||
        null;
    };
    sync();
    if (!this.cachedVoices.length) {
      globalThis.speechSynthesis.onvoiceschanged = () => sync();
    }
  }

  configure({ language } = {}) {
    if (typeof language === "string" && language.trim()) {
      this.language = language.trim();
      this.preferredVoice = null;
      this.loadVoices();
    }
    this.emitStatus();
  }

  isRecognitionSupported() {
    return Boolean(getRecognitionCtor());
  }

  isSpeechSupported() {
    return Boolean(globalThis.speechSynthesis && globalThis.SpeechSynthesisUtterance);
  }

  getStatus() {
    return {
      supported: this.isRecognitionSupported(),
      speechSupported: this.isSpeechSupported(),
      listening: this.listening,
      speaking: this.speaking,
      lastTranscript: this.lastTranscript,
      lastReply: this.lastReply,
      lastError: this.lastError
    };
  }

  startListening() {
    if (this.listening) {
      return this.stopListening("user_stop");
    }

    const Recognition = getRecognitionCtor();
    if (!Recognition) {
      this.lastError = "speech_recognition_unavailable";
      this.emitStatus();
      throw new Error("Browser speech recognition is unavailable.");
    }

    this.cancelSpeech();
    this.lastError = "";
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = this.language;
    recognition.maxAlternatives = 1;

    let finalText = "";
    recognition.onstart = () => {
      this.listening = true;
      this.emitStatus();
    };
    recognition.onresult = (event) => {
      for (let index = event.resultIndex || 0; index < (event.results?.length || 0); index += 1) {
        const result = event.results[index];
        const text = String(result?.[0]?.transcript || "").trim();
        if (text && result.isFinal) {
          finalText += `${finalText ? " " : ""}${text}`;
        }
      }
    };
    recognition.onerror = (event) => {
      this.lastError = String(event?.error || "speech_recognition_error");
      if (!NON_RETRYABLE_RECOGNITION_ERRORS.has(this.lastError)) {
        this.log(`Browser voice recognition error: ${this.lastError}`, "warn");
      }
      this.emitStatus();
    };
    recognition.onend = () => {
      const isCurrent = this.recognition === recognition;
      if (isCurrent) {
        this.recognition = null;
        this.listening = false;
      }
      const text = finalText.trim();
      if (isCurrent && text) {
        this.lastTranscript = text;
        Promise.resolve(this.onTranscript?.(text)).catch((error) => {
          this.lastError = error.message;
          this.emitStatus();
        });
      }
      this.emitStatus();
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      this.recognition = null;
      this.listening = false;
      this.lastError = error.message;
      this.emitStatus();
      throw error;
    }
    return true;
  }

  stopListening(reason = "stop") {
    const recognition = this.recognition;
    this.recognition = null;
    this.listening = false;
    try {
      recognition?.stop?.();
    } catch (_error) {
      try {
        recognition?.abort?.();
      } catch (_abortError) {
        // Cleanup is best effort when a browser has already ended recognition.
      }
    }
    this.log(`Browser voice capture stopped (${reason}).`, "debug");
    this.emitStatus();
    return false;
  }

  speak(text) {
    const reply = String(text || "").trim();
    if (!reply) {
      return false;
    }
    if (!this.isSpeechSupported()) {
      this.lastError = "speech_synthesis_unavailable";
      this.emitStatus();
      return false;
    }

    this.cancelSpeech();
    const token = ++this.speechToken;
    this.lastReply = reply;
    this.lastError = "";

    // 若 voices 尚未加载，先刷新一次；仍无字音则延迟 250ms 重试一次
    if (!this.cachedVoices.length) {
      this.loadVoices();
    }

    const speakNow = () => {
      if (token !== this.speechToken) return;
      const utterance = new globalThis.SpeechSynthesisUtterance(reply);
      utterance.lang = this.language;
      utterance.rate = 1;
      if (this.preferredVoice) {
        utterance.voice = this.preferredVoice;
      }
      utterance.onstart = () => {
        if (token !== this.speechToken) return;
        this.speaking = true;
        this.emitStatus();
      };
      utterance.onend = () => {
        if (token !== this.speechToken) return;
        this.speaking = false;
        this.emitStatus();
      };
      utterance.onerror = (event) => {
        if (token !== this.speechToken) return;
        this.speaking = false;
        this.lastError = String(event?.error || "speech_synthesis_error");
        this.emitStatus();
      };
      globalThis.speechSynthesis.speak(utterance);
    };

    if (!this.preferredVoice && !this.cachedVoices.length) {
      globalThis.setTimeout(speakNow, 250);
    } else {
      speakNow();
    }
    return true;
  }

  cancelSpeech() {
    this.speechToken += 1;
    this.speaking = false;
    try {
      globalThis.speechSynthesis?.cancel?.();
    } catch (_error) {
      // Browser speech cleanup is best effort.
    }
    this.emitStatus();
  }

  stop() {
    this.stopListening("runtime_stop");
    this.cancelSpeech();
  }

  emitStatus() {
    this.onStatus?.(this.getStatus());
  }

  log(message, level = "info") {
    this.logger?.(message, level);
  }
}

function getRecognitionCtor() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}
