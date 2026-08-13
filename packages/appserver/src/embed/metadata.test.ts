/**
 * Unit tests for the pure HTML-parsing helpers in `metadata.ts`.
 *
 * These don't hit the network — they exercise the oEmbed/OpenGraph
 * extraction that `fetchLinkMetadata` composes. The network path is covered
 * manually (the whole point is real-world yield against bot-blocking).
 */
import { describe, expect, test } from "bun:test";
import {
  htmlDecode,
  extractMeta,
  extractTitle,
  extractOEmbedEndpoint,
  extractIframeSrc,
  buildOEmbedUrl,
  ogToMetadata,
  oEmbedToMetadata,
  mergeMetadata,
} from "./metadata.ts";

const OG_HTML = `<html><head>
  <meta property="og:title" content="Roomy — community chat" />
  <meta property="og:description" content="Built on ATProto" />
  <meta property="og:image" content="https://roomy.space/img/og.png" />
  <meta property="og:site_name" content="Roomy" />
  <meta name="twitter:title" content="Roomy" />
  <title>Fallback &amp; Title</title>
</head></html>`;

describe("extractMeta", () => {
  test("reads og:property content regardless of attribute order", () => {
    expect(extractMeta(OG_HTML, "og:title", "property")).toBe(
      "Roomy — community chat",
    );
    expect(extractMeta(OG_HTML, "og:site_name", "property")).toBe("Roomy");
  });

  test("reads name-attribute meta tags", () => {
    expect(extractMeta(OG_HTML, "twitter:title", "name")).toBe("Roomy");
  });

  test("returns null when the tag is absent", () => {
    expect(extractMeta(OG_HTML, "og:nope", "property")).toBeNull();
  });
});

describe("htmlDecode", () => {
  test("decodes common entities", () => {
    expect(htmlDecode("Tom &amp; Jerry &#39;x&#39; &quot;y&quot;")).toBe(
      "Tom & Jerry 'x' \"y\"",
    );
  });
});

describe("extractTitle", () => {
  test("falls back to <title>", () => {
    expect(extractTitle(OG_HTML)).toBe("Fallback & Title");
  });
});

describe("extractOEmbedEndpoint", () => {
  test("finds a json+oembed alternate link", () => {
    const html = `<link rel="alternate" type="application/json+oembed"
      href="https://example.com/services/oembed?format=json&url={url}" />`;
    expect(extractOEmbedEndpoint(html)).toBe(
      "https://example.com/services/oembed?format=json&url={url}",
    );
  });

  test("returns null when no oEmbed endpoint is advertised", () => {
    expect(extractOEmbedEndpoint(OG_HTML)).toBeNull();
  });
});

describe("buildOEmbedUrl", () => {
  test("fills the {url} template placeholder", () => {
    expect(
      buildOEmbedUrl("https://e.com/o?url={url}", "https://a.com/x"),
    ).toBe("https://e.com/o?url=https%3A%2F%2Fa.com%2Fx");
  });

  test("appends url param when no placeholder present", () => {
    expect(buildOEmbedUrl("https://e.com/o?format=json", "https://a.com/x")).toBe(
      "https://e.com/o?format=json&url=https%3A%2F%2Fa.com%2Fx",
    );
  });
});

describe("extractIframeSrc", () => {
  test("extracts an iframe src", () => {
    expect(
      extractIframeSrc(`<iframe width="1" height="1" src="https://e.com/embed" />`),
    ).toBe("https://e.com/embed");
  });
});

describe("ogToMetadata", () => {
  test("maps og tags into the normalized shape", () => {
    expect(ogToMetadata(OG_HTML)).toEqual({
      t: "Roomy — community chat",
      d: "Built on ATProto",
      p: { n: "Roomy" },
      imgs: [{ u: "https://roomy.space/img/og.png" }],
    });
  });

  test("falls back to <title> when og:title is missing", () => {
    const html = `<html><head><title>Just a title</title></head></html>`;
    expect(ogToMetadata(html)).toEqual({ t: "Just a title" });
  });
});

describe("oEmbedToMetadata", () => {
  test("maps oEmbed fields into the normalized shape", () => {
    const out = oEmbedToMetadata({
      type: "video",
      title: "A video",
      provider_name: "YouTube",
      provider_url: "https://youtube.com",
      author_name: "Author",
      thumbnail_url: "https://img/thumb.jpg",
      thumbnail_width: 480,
      thumbnail_height: 360,
      html: '<iframe src="https://youtube.com/embed/abc"></iframe>',
    });
    expect(out.t).toBe("A video");
    expect(out.p).toEqual({ n: "YouTube", u: "https://youtube.com" });
    expect(out.au).toEqual({ n: "Author" });
    expect(out.imgs).toEqual([{ u: "https://img/thumb.jpg", w: 480, h: 360 }]);
    expect(out.vid).toEqual({ u: "https://youtube.com/embed/abc" });
  });
});

describe("mergeMetadata", () => {
  test("prefers `a` and fills gaps from `b`", () => {
    const a = { t: "oembed title", p: { n: "YouTube" } };
    const b = { t: "og title", d: "description", imgs: [{ u: "img.png" }] };
    expect(mergeMetadata(a, b)).toEqual({
      t: "oembed title",
      p: { n: "YouTube" },
      d: "description",
      imgs: [{ u: "img.png" }],
    });
  });
});
