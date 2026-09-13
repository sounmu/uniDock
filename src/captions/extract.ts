/** Self-contained: serialized by chrome.scripting into each permitted frame.
 * DOM pass runs everywhere first. Only an empty DOM result permits the KU VTT pass.
 */
export async function collectCaptionSources(
  mode: "dom" | "player" | "script",
  deadline = Date.now() + 10000,
) {
  const items: { time: string; text: string }[] = [];
  const result = {
    items,
    vtt: "",
    script: "",
    label: "",
    source:
      mode === "dom"
        ? "caption_script_dom"
        : mode === "script"
          ? "player_media_script"
          : "player_vtt",
    blocked: false,
    limited: false,
    pageUrl: location.href,
    pageTitle: document.title,
  };
  const own = (value: unknown, key: string): unknown => {
    if (!value || (typeof value !== "object" && typeof value !== "function"))
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  // KU's Base.extend models keep default fields on their prototypes. Never invoke accessors.
  const data = (value: unknown, key: string): unknown => {
    for (
      let depth = 0;
      value && typeof value === "object" && depth < 5;
      depth++
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor)
        return "value" in descriptor ? descriptor.value : undefined;
      value = Object.getPrototypeOf(value);
    }
    return undefined;
  };
  const string = (value: unknown): string =>
    typeof value === "string" ? value : "";
  if (mode === "dom") {
    const rows = document.querySelectorAll(
      "#cs-script-list > li.cs-script-item",
    );
    if (rows.length > 20000) {
      result.limited = true;
      return result;
    }
    let size = 0;
    for (const row of rows) {
      const time =
        row.querySelector(".cs-script-item-time")?.textContent?.trim() ?? "";
      const text =
        row
          .querySelector(".cs-script-item-text")
          ?.textContent?.replace(/\s+/g, " ")
          .trim() ?? "";
      if (!text) continue;
      size += text.length;
      if (size > 1000000) {
        result.limited = true;
        items.length = 0;
        return result;
      }
      if (!time) {
        result.blocked = true;
        items.length = 0;
        return result;
      }
      items.push({ time, text });
    }
    return result;
  }
  if (
    location.origin !== "https://kucom.korea.ac.kr" ||
    !location.pathname.startsWith("/em/")
  )
    return result;
  if (mode === "script") {
    // KU UPF recordings can provide MediaScriptData TXT instead of closed captions.
    // Read the already-loaded text; do not execute player methods or synthesize timing.
    const list = data(own(window, "uniPlayerConfig"), "_mediaScriptList");
    if (!Array.isArray(list)) return result;
    if (list.length > 20) {
      result.limited = true;
      return result;
    }
    const candidates: { label: string; lang: string; text: string }[] = [];
    for (let index = 0; index < list.length; index++) {
      const row = own(list, String(index));
      const text = string(data(row, "script"));
      if (text.trim())
        candidates.push({
          label: string(data(row, "label")),
          lang: string(data(row, "lang")),
          text,
        });
    }
    const selected =
      candidates.find(
        (row) =>
          /^(?:ko(?:-|$)|kor$|kr$)/i.test(row.lang.replaceAll("_", "-")) ||
          /korean|한국|한글|국문/i.test(`${row.lang} ${row.label}`),
      ) ?? candidates[0];
    if (selected) {
      if (selected.text.length > 1000000) {
        result.limited = true;
        return result;
      }
      result.script = selected.text;
      result.label = selected.label || selected.lang || "플레이어 스크립트";
    }
    return result;
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, Math.min(10000, deadline - Date.now())),
  );
  const read = async (
    value: string,
    base: string,
    extension: "xml" | "vtt",
  ) => {
    if (controller.signal.aborted || Date.now() >= deadline)
      throw new Error("TIMEOUT");
    const url = new URL(value, base);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.toLowerCase().endsWith(`.${extension}`)
    )
      throw new Error("UNSAFE_URL");
    const response = await fetch(url.href, {
      method: "GET",
      credentials: url.origin === location.origin ? "same-origin" : "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (
      !response.ok ||
      Number(response.headers.get("content-length")) > 1000000
    )
      throw new Error("FETCH");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("FETCH");
    const decoder = new TextDecoder();
    let body = "",
      size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1000000) throw new Error("LIMIT");
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { body, url: url.href };
  };
  try {
    const config = own(window, "uniPlayerConfig");
    if (!config) return result;
    // Verified against KU uni-player 1.2.0.63: getContentPlayingInfoData simply
    // returns this field. Read it directly so no player method is executed.
    const info = data(config, "_contentPlayingInfoData");
    if (!info || data(info, "useCaption") === false) return result;
    const stories = data(info, "storyList");
    if (!Array.isArray(stories) || stories.length > 200) {
      result.blocked = true;
      return result;
    }
    let main: unknown;
    for (let index = 0; index < stories.length; index++) {
      const story = own(stories, String(index));
      if (story && data(story, "isIntro") !== true) {
        main = story;
        break;
      }
    }
    if (!main) return result;
    const directory = (value: string): string => {
      const url = new URL(value, location.href);
      if (!url.pathname.endsWith("/")) url.pathname += "/";
      return url.href;
    };
    const staticCaption = string(data(info, "captionUri"));
    const contentBase =
      data(info, "contentType") === "remix"
        ? string(data(main, "remixWebUri"))
        : string(data(info, "contentUri"));
    const base = staticCaption || contentBase;
    if (!base) return result;
    const resourceBase = directory(base);
    const captionUrl = staticCaption
      ? "caption_list.xml"
      : string(data(data(main, "storyFileNameList"), "caption"));
    if (!captionUrl) return result;
    const xml = await read(captionUrl, resourceBase, "xml");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml.body)) throw new Error("INVALID_XML");
    const doc = new DOMParser().parseFromString(xml.body, "application/xml");
    if (
      doc.querySelector("parsererror") ||
      doc.documentElement.localName.toLowerCase() === "html"
    )
      throw new Error("INVALID_XML");
    // Caption lists may express fields as attributes or child elements.
    const candidates: { url: string; label: string; language: string }[] = [];
    for (const element of Array.from(doc.querySelectorAll("*")).slice(
      0,
      2000,
    )) {
      const field = (names: string[]) => {
        for (const name of names) {
          const value =
            element.getAttribute(name) ??
            Array.from(element.children).find(
              (child) => child.localName.toLowerCase() === name.toLowerCase(),
            )?.textContent;
          if (value?.trim()) return value.trim();
        }
        return "";
      };
      const url =
        field(["uri", "src", "url", "file", "filename"]) ||
        (element.children.length === 0
          ? (element.textContent?.trim() ?? "")
          : "");
      if (!/\.vtt(?:\?|$)/i.test(url)) continue;
      const label = field(["label", "name", "title"]);
      const language = field(["lang", "language", "srclang", "code"]);
      candidates.push({ url, label, language });
    }
    const selected =
      candidates.find(
        (item) =>
          /^(?:ko(?:-|$)|kor$|kr$)/i.test(item.language.replaceAll("_", "-")) ||
          /korean|한국|한글|국문/i.test(`${item.language} ${item.label}`),
      ) ?? candidates[0];
    if (!selected) return result;
    result.vtt = (await read(selected.url, resourceBase, "vtt")).body;
    result.label = selected.label || selected.language || "자막";
  } catch {
    result.blocked = true;
  } finally {
    clearTimeout(timer);
  }
  return result;
}
