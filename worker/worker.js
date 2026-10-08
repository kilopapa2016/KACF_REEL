/* site-reel 페이지 중계 Worker (Cloudflare Workers)
   reel.html이 다른 사이트의 HTML을 직접 읽을 수 없는(CORS) 문제를 풀기 위한 중계소.
   사용: https://<워커주소>/?url=https://www.example.com
   하는 일: 그 페이지의 HTML을 받아 "읽어 가도 됨" 헤더를 붙여 돌려준다. 분석은 reel.html이 한다.

   안전장치
   · GET 요청과 http/https 주소만 받는다
   · 내부망 주소(localhost, 사설 IP 등)는 거절한다
   · HTML 페이지와 작은 이미지(512KB 이하, 로고 밝기 판정용)만 중계한다
   · 2MB를 넘는 페이지는 거절한다, 10초 안에 응답이 없으면 끊는다
   · 글자 인코딩(EUC-KR 등)은 그대로 넘기고, 디코딩은 브라우저(reel.html)가 한다 */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 512 * 1024;
const TIMEOUT_MS = 10000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "X-Final-URL, Content-Type",
};

function fail(status, message) {
  return new Response(message, { status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
}

// 내부망·로컬 주소 차단
function isBlockedHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return h.includes(":");
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || isBlockedHost(u.hostname)) return null;
  return u;
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return fail(405, "GET 요청만 받습니다.");

    const target = checkUrl(new URL(request.url).searchParams.get("url") || "");
    if (!target) return fail(400, "올바른 공개 주소(https://...)를 ?url= 뒤에 넣어 주세요.");

    let res;
    try {
      res = await fetch(target.href, {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 site-reel",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        },
        cf: { cacheTtl: 300 },
      });
    } catch (e) {
      return fail(502, "사이트에 접속하지 못했습니다: " + (e && e.message || e));
    }

    // 리다이렉트 끝 주소도 다시 검사
    const finalUrl = checkUrl(res.url || target.href);
    if (!finalUrl) return fail(400, "리다이렉트된 주소가 허용되지 않습니다.");
    if (!res.ok) return fail(502, `사이트가 오류를 돌려줬습니다 (HTTP ${res.status}).`);

    const type = res.headers.get("content-type") || "";
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(type);
    const isImage = /^image\/(png|jpe?g|gif|webp|svg\+xml)/i.test(type);
    if (!isHtml && !isImage) return fail(415, "HTML 페이지(또는 작은 이미지)만 가져옵니다.");
    const limit = isHtml ? MAX_BYTES : MAX_IMAGE_BYTES;
    const tooBig = isHtml ? "페이지가 너무 큽니다 (2MB 초과)." : "이미지가 너무 큽니다 (512KB 초과).";
    if (Number(res.headers.get("content-length") || 0) > limit) return fail(413, tooBig);

    // 크기 제한을 지키며 읽기
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return fail(413, tooBig); }
      chunks.push(value);
    }
    const body = new Uint8Array(size); let off = 0;
    for (const c of chunks) { body.set(c, off); off += c.byteLength; }

    return new Response(body, {
      headers: { ...CORS, "content-type": type, "X-Final-URL": finalUrl.href, "Cache-Control": "public, max-age=300" },
    });
  },
};
