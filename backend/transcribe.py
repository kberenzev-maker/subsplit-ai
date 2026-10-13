"""
Transcribe module: High-precision, GPU-accelerated local speech recognition
with word-level timestamps using Apple Silicon Metal (mlx-whisper float16)
and faster-whisper fallback.
"""

import sys
import os
import glob
import json
import wave
from typing import List, Dict, Any, Tuple, Optional
import numpy as np


# Славянские/кириллические коды, которые Whisper может случайно перепутать с русским на коротких отрезках
_SLAVIC_TO_RU = {"ru", "uk", "be", "bg", "mk", "sr", "kk", "ky", "mn", "tg"}


def _get_optimal_compute_type() -> str:
    """Определяет наиболее быстрый и энергоэффективный тип квантования CPU."""
    try:
        import ctranslate2
        supported = ctranslate2.get_supported_compute_types("cpu")
        if "int8_float32" in supported:
            return "int8_float32"
        if "int8" in supported:
            return "int8"
    except Exception:
        pass
    return "int8"


def load_audio_wave(audio_path: str) -> Tuple[np.ndarray, int]:
    """Быстро загружает 16kHz mono WAV файл в float32 numpy массив."""
    with wave.open(audio_path, "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        frames = w.getnframes()
        sampwidth = w.getsampwidth()
        raw = w.readframes(frames)
        if sampwidth == 2:
            data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        elif sampwidth == 4:
            data = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
        else:
            data = np.frombuffer(raw, dtype=np.float32)
        if ch > 1:
            data = data.reshape(-1, ch).mean(axis=1)
        return data, sr


def _split_long_interval(
    audio_data: np.ndarray,
    sr: int,
    start_sec: float,
    end_sec: float,
    max_len: float = 26.0
) -> List[Tuple[float, float]]:
    """
    Если непрерывный участок длиннее max_len (26 сек), разрезает его
    в точке с минимальной громкостью (естественной паузе речи) в диапазоне [12..26] сек.
    """
    res: List[Tuple[float, float]] = []
    curr = start_sec
    while end_sec - curr > max_len:
        # Ищем самую тихую паузу (окно 150 мс) в интервале [curr + 12s, curr + max_len]
        search_s = int((curr + 12.0) * sr)
        search_e = min(len(audio_data), int((curr + max_len) * sr))
        if search_e <= search_s + int(0.3 * sr):
            split_t = curr + max_len
        else:
            win = max(1, int(0.10 * sr))
            segment = audio_data[search_s:search_e]
            n_wins = len(segment) // win
            if n_wins > 1:
                rms = np.sqrt(np.mean(segment[: n_wins * win].reshape(n_wins, win) ** 2, axis=1))
                min_idx = int(np.argmin(rms))
                split_t = round((search_s + min_idx * win + win // 2) / sr, 3)
            else:
                split_t = curr + max_len
        res.append((round(curr, 3), round(split_t, 3)))
        curr = split_t
    if end_sec - curr >= 0.15:
        res.append((round(curr, 3), round(end_sec, 3)))
    return res


def _detect_acoustic_islands(
    audio_data: np.ndarray,
    sr: int,
    min_silence_sec: float = 0.75,
    max_island_sec: float = 26.0
) -> List[Tuple[float, float]]:
    """
    Быстрое (2 мс) определение речевых островов по энергии сигнала.
    Разделяет аудио по длинным паузам (>= 0.75 сек), чтобы никогда не склеивать
    далекие куски таймлайна (например, через 50 секунд тишины).
    """
    total_sec = len(audio_data) / sr if sr > 0 else 0.0
    if total_sec <= 0.15:
        return []

    hop = max(1, int(0.02 * sr))  # шаг 20 мс
    n_frames = len(audio_data) // hop
    if n_frames == 0:
        return [(0.0, round(total_sec, 3))]

    frames = audio_data[: n_frames * hop].reshape(n_frames, hop)
    rms = np.sqrt(np.mean(frames ** 2, axis=1))

    # Адаптивный порог тишины
    non_zero = rms[rms > 0.0005]
    thresh = max(0.004, float(np.percentile(non_zero, 12)) * 0.6) if len(non_zero) > 10 else 0.005
    is_speech = rms > thresh

    min_silence_frames = int(min_silence_sec / 0.02)
    pad_frames = int(0.22 / 0.02)  # 220 мс запас по краям фразы

    islands: List[Tuple[float, float]] = []
    in_speech = False
    s_frame = 0
    silence_run = 0

    for idx, sp in enumerate(is_speech):
        if sp:
            if not in_speech:
                in_speech = True
                s_frame = max(0, idx - pad_frames)
            silence_run = 0
        else:
            if in_speech:
                silence_run += 1
                if silence_run >= min_silence_frames:
                    e_frame = min(n_frames, idx - silence_run + pad_frames)
                    s_t = s_frame * 0.02
                    e_t = e_frame * 0.02
                    if e_t - s_t >= 0.18:
                        islands.extend(_split_long_interval(audio_data, sr, s_t, e_t, max_island_sec))
                    in_speech = False
                    silence_run = 0

    if in_speech:
        e_frame = n_frames
        s_t = s_frame * 0.02
        e_t = min(total_sec, e_frame * 0.02 + 0.1)
        if e_t - s_t >= 0.18:
            islands.extend(_split_long_interval(audio_data, sr, s_t, e_t, max_island_sec))

    return islands if islands else [(0.0, round(total_sec, 3))]


def _build_smart_islands(
    audio_data: np.ndarray,
    sr: int,
    clip_cuts: Optional[List[Dict[str, Any]]]
) -> List[Tuple[float, float]]:
    """
    Формирует оптимальные речевые острова из склеек Premiere Pro (.cuts.json):
    1. Склеивает соседние джамп-каты ОДНОГО И ТОГО ЖЕ исходника (clip.name == prev.name),
       если пауза между ними <= 1.0 сек и общая длина <= 26 сек.
       Это сохраняет естественный контекст речи на склейках внутри монолога (не проглатывая
       короткие союзы вроде «а то, как мы») и сокращает число вызовов Whisper в 4-5 раз!
    2. Никогда не объединяет клипы из разных видеофайлов (предотвращая смешение RU + EN в одном окне)
       и никогда не объединяет клипы через паузы > 1.0 сек.
    """
    total_sec = len(audio_data) / sr if sr > 0 else 0.0
    if not clip_cuts:
        return _detect_acoustic_islands(audio_data, sr)

    valid_cuts = []
    for c in clip_cuts:
        cs = max(0.0, float(c.get("start", 0.0)))
        ce = min(total_sec, float(c.get("end", 0.0)))
        cname = str(c.get("name", "")).strip()
        if ce - cs >= 0.15:
            valid_cuts.append({"start": cs, "end": ce, "name": cname})

    if not valid_cuts:
        return _detect_acoustic_islands(audio_data, sr)

    valid_cuts.sort(key=lambda x: x["start"])

    grouped: List[Dict[str, Any]] = []
    for cut in valid_cuts:
        if not grouped:
            grouped.append(dict(cut))
            continue

        prev = grouped[-1]
        gap = cut["start"] - prev["end"]
        combined_dur = cut["end"] - prev["start"]
        same_source = bool(cut["name"] and cut["name"] == prev["name"])

        if same_source and gap <= 1.0 and combined_dur <= 26.0:
            prev["end"] = max(prev["end"], cut["end"])
        else:
            grouped.append(dict(cut))

    islands: List[Tuple[float, float]] = []
    for g in grouped:
        islands.extend(_split_long_interval(audio_data, sr, g["start"], g["end"], max_len=26.0))

    return islands


def _resolve_mlx_repo(model_size: str) -> Optional[str]:
    """Проверяет наличие локального MLX-снапшота модели для мгновенной загрузки без сети."""
    if model_size in ("large-v3-turbo", "turbo", "large-v3"):
        repo_dir = os.path.expanduser(
            "~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo/snapshots/*"
        )
        snaps = sorted(glob.glob(repo_dir))
        if snaps:
            return snaps[-1]
        return "mlx-community/whisper-large-v3-turbo"
    return None


def _select_island_language_mlx(
    model: Any,
    audio_features: Any,
    requested_lang: Optional[str],
    DecodingOptions: Any
) -> str:
    """
    Высокоточное определение языка речевого острова (RU vs EN) по уже вычисленным
    признакам энкодера (audio_features):
    - Если речь уверенно русская -> 'ru'
    - Если спикер задает вопрос с русским акцентом на английском (например, IMG_0259.MOV),
      сравнивает avg_logprob декодирования RU и EN за 0.08 сек и безошибочно выбирает язык с более высокой вероятностью!
    """
    try:
        _, probs_list = model.detect_language(audio_features)
        probs = probs_list[0] if isinstance(probs_list, list) else probs_list
    except Exception:
        return requested_lang or "ru"

    p_ru = sum(float(probs.get(code, 0.0)) for code in _SLAVIC_TO_RU)
    p_en = float(probs.get("en", 0.0))

    top_lang = max(probs, key=probs.get)
    top_prob = float(probs.get(top_lang, 0.0))
    if top_lang in _SLAVIC_TO_RU:
        top_lang = "ru"
        top_prob = p_ru

    # Если явно задан конкретный иностранный язык (es, de, fr и т.д.)
    if requested_lang and requested_lang not in ("auto", "ru", "en"):
        if float(probs.get(requested_lang, 0.0)) >= 0.15:
            return requested_lang

    # Быстрый путь: если уверенность >= 92% в русском языке
    if top_lang == "ru" and p_ru >= 0.92 and p_en < 0.05:
        return "ru"
    if top_lang == "en" and p_en >= 0.92 and p_ru < 0.05:
        return "en"

    # Если есть сомнение между RU и EN (например, английская речь с русским акцентом),
    # проверяем avg_logprob на уже готовом audio_features[0] (занимает ~0.09 сек на GPU!)
    cand_primary = "ru" if p_ru >= p_en else "en"
    cand_alt = "en" if cand_primary == "ru" else "ru"

    try:
        res_prim = model.decode(
            audio_features[0],
            DecodingOptions(temperature=0.0, language=cand_primary, fp16=True)
        )
        # Если декодирование уверенное и нет конкурирующего языка, сразу возвращаем
        if res_prim.avg_logprob > -0.28 and max(p_ru, p_en) >= 0.85:
            return cand_primary

        res_alt = model.decode(
            audio_features[0],
            DecodingOptions(temperature=0.0, language=cand_alt, fp16=True)
        )
        if res_alt.avg_logprob > res_prim.avg_logprob + 0.06:
            return cand_alt
        return cand_primary
    except Exception:
        return cand_primary


def _transcribe_with_mlx(
    audio_data: np.ndarray,
    sr: int,
    islands: List[Tuple[float, float]],
    mlx_repo: str,
    whisper_lang: Optional[str]
) -> List[Dict[str, Any]]:
    """
    Ультра-быстрая транскрибация на Apple Silicon GPU (Metal float16) через mlx-whisper
    с однократным кэшированием аудио-энкодера на каждом речевом острове.
    """
    import gc
    import mlx.core as mx
    import mlx_whisper
    from mlx_whisper.transcribe import ModelHolder
    from mlx_whisper.audio import log_mel_spectrogram, pad_or_trim, N_FRAMES, N_SAMPLES
    from mlx_whisper.decoding import DecodingOptions

    print("STATUS:Загрузка модели Whisper Turbo на Apple Silicon GPU (Metal float16)...", flush=True)
    model = ModelHolder.get_model(mlx_repo, mx.float16)
    orig_encoder = model.encoder

    # Однократное кэширование выхода энкодера внутри одного речевого острова (ускорение в 3 раза!)
    _enc_cache: Dict[str, Any] = {"feat": None}

    def _cached_encoder(mel):
        if _enc_cache["feat"] is not None:
            return _enc_cache["feat"]
        feat = orig_encoder(mel)
        mx.eval(feat)
        _enc_cache["feat"] = feat
        return feat

    model.encoder = _cached_encoder

    total_duration = len(audio_data) / sr if sr > 0 else 1.0
    all_words: List[Dict[str, Any]] = []
    last_pct = 0

    print(
        f"STATUS:Распознавание на Apple GPU ({len(islands)} речевых сегм., float16)...",
        flush=True
    )

    try:
        for idx, (s_sec, e_sec) in enumerate(islands):
            s_sample = max(0, int(s_sec * sr))
            e_sample = min(len(audio_data), int(e_sec * sr))
            chunk = audio_data[s_sample:e_sample]
            if len(chunk) < int(0.15 * sr):
                continue

            # Проверяем, не чистая ли тишина на этом участке
            rms = float(np.sqrt(np.mean(chunk ** 2)))
            if rms < 0.0015:
                continue

            _enc_cache["feat"] = None

            # Вычисляем mel и однократно прогоняем через энкодер GPU
            mel = log_mel_spectrogram(chunk, n_mels=model.dims.n_mels, padding=N_SAMPLES)
            mel_seg = pad_or_trim(mel, N_FRAMES, axis=-2).astype(mx.float16)
            af = _cached_encoder(mel_seg[None])

            # Определяем точный язык острова (защита от ложного русского на акцентном английском)
            island_lang = _select_island_language_mlx(model, af, whisper_lang, DecodingOptions)

            res = mlx_whisper.transcribe(
                chunk,
                path_or_hf_repo=mlx_repo,
                language=island_lang,
                word_timestamps=True,
                temperature=0.0,
                condition_on_previous_text=False,
                no_speech_threshold=0.65,
                hallucination_silence_threshold=1.5
            )

            chunk_dur = (e_sample - s_sample) / sr
            for seg in res.get("segments", []):
                if seg.get("no_speech_prob", 0.0) > 0.80 and seg.get("avg_logprob", 0.0) < -0.7:
                    continue
                for w in seg.get("words", []):
                    cleaned_text = w.get("word", "").strip()
                    if not cleaned_text:
                        continue
                    w_start = max(0.0, min(chunk_dur, float(w.get("start", 0.0))))
                    w_end = max(w_start, min(chunk_dur + 0.15, float(w.get("end", w_start + 0.1))))
                    all_words.append({
                        "text": cleaned_text,
                        "word": cleaned_text,
                        "start": round(s_sec + w_start, 3),
                        "end": round(s_sec + w_end, 3),
                        "probability": float(w.get("probability", 1.0))
                    })

            pct = min(99, max(5, int((e_sec / total_duration) * 100)))
            if pct > last_pct:
                last_pct = pct
                print(f"PROGRESS:{pct}", flush=True)
    finally:
        model.encoder = orig_encoder
        _enc_cache["feat"] = None
        gc.collect()

    print("PROGRESS:100", flush=True)
    return all_words


def transcribe_audio(
    audio_path: str,
    model_size: str = "large-v3-turbo",
    language: str = "ru"
) -> List[Dict[str, Any]]:
    """
    Распознает речь из аудиофайла с посекундными таймингами каждого слова.
    Использует Apple Silicon Metal GPU (mlx-whisper float16) + умную группировку
    склеек таймлайна Premiere Pro (.cuts.json).
    """
    import gc

    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Файл не найден: {audio_path}")

    if model_size == "turbo":
        model_size = "large-v3-turbo"

    # Загружаем WAV и границы склеек таймлайна (.cuts.json), если есть
    cuts_json_path = audio_path + ".cuts.json"
    clip_cuts = None
    if os.path.exists(cuts_json_path):
        try:
            with open(cuts_json_path, "r", encoding="utf-8") as f:
                clip_cuts = json.load(f)
        except Exception:
            clip_cuts = None

    audio_data, sr = load_audio_wave(audio_path)
    islands = _build_smart_islands(audio_data, sr, clip_cuts)
    whisper_lang = None if (language in (None, "auto", "")) else language

    # 1. Пробуем нативный Apple Silicon GPU движок (mlx-whisper float16)
    mlx_repo = _resolve_mlx_repo(model_size)
    if mlx_repo is not None:
        try:
            all_words = _transcribe_with_mlx(audio_data, sr, islands, mlx_repo, whisper_lang)
            try:
                from chunker import merge_broken_tokens
                all_words = merge_broken_tokens(all_words)
            except Exception:
                pass
            print(f"STATUS:Распознано {len(all_words)} слов (Apple GPU).", flush=True)
            return all_words
        except Exception as mlx_err:
            print(f"STATUS:Переключение на CPU движок ({mlx_err})...", flush=True)

    # 2. Резервный CPU движок faster-whisper по умным речевым островам
    from faster_whisper import WhisperModel

    print(f"STATUS:Загрузка модели Whisper '{model_size}'...", flush=True)
    compute_type = _get_optimal_compute_type()
    cpu_threads = min(8, os.cpu_count() or 4)
    model = WhisperModel(model_size, device="cpu", compute_type=compute_type, cpu_threads=cpu_threads)

    total_duration = len(audio_data) / sr if sr > 0 else 1.0
    all_words: List[Dict[str, Any]] = []
    last_pct = 0

    print(f"STATUS:Распознавание речи ({len(islands)} речевых сегм.)...", flush=True)

    for s_sec, e_sec in islands:
        s_sample = max(0, int(s_sec * sr))
        e_sample = min(len(audio_data), int(e_sec * sr))
        chunk = audio_data[s_sample:e_sample]
        if len(chunk) < int(0.15 * sr):
            continue

        segments, _ = model.transcribe(
            chunk,
            language=None,
            multilingual=True,
            word_timestamps=True,
            beam_size=1,
            temperature=0.0,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=400, speech_pad_ms=250)
        )

        chunk_dur = (e_sample - s_sample) / sr
        for segment in segments:
            if segment.words:
                for w in segment.words:
                    cleaned_text = w.word.strip()
                    if cleaned_text:
                        w_start = max(0.0, min(chunk_dur, w.start))
                        w_end = max(w_start, min(chunk_dur + 0.15, w.end))
                        all_words.append({
                            "text": cleaned_text,
                            "word": cleaned_text,
                            "start": round(s_sec + w_start, 3),
                            "end": round(s_sec + w_end, 3),
                            "probability": getattr(w, "probability", 1.0)
                        })

        pct = min(99, max(5, int((e_sec / total_duration) * 100)))
        if pct > last_pct:
            last_pct = pct
            print(f"PROGRESS:{pct}", flush=True)

    print("PROGRESS:100", flush=True)
    del model
    gc.collect()

    try:
        from chunker import merge_broken_tokens
        all_words = merge_broken_tokens(all_words)
    except Exception:
        pass

    print(f"STATUS:Распознано {len(all_words)} слов.", flush=True)
    return all_words
