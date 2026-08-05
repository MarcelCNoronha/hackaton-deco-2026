import { describe, expect, it } from "vitest";
import { renderPdp, renderPdpHtml, renderPdpHtmlFromTemplate, renderPdpLayout } from "./publisher.agent.js";
import type { PdpLayoutRow } from "../repositories/pdp-templates.repo.js";

describe("renderPdpHtml", () => {
  it("escapes HTML-significant characters so a malicious/odd attribute value can't inject markup", () => {
    const html = renderPdpHtml(["description"], "plain", { description: "Resistente a <script>alert(1)</script> & cia" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; cia");
  });

  it("renders bullets as plain text (no bullet rows) on the Médio (plain) level", () => {
    const html = renderPdpHtml(["benefit_bullets"], "plain", { bullets: ["Fácil de limpar", "Alta durabilidade"] });
    expect(html).not.toContain("catalogia-bullets");
    expect(html).toContain("Fácil de limpar");
  });

  it("renders bullets as a marked list on structured levels (Bom/Excelente) — using a literal • rather than <ul>/<li>'s native marker, which this store's theme silently hides even with an explicit list-style", () => {
    const html = renderPdpHtml(["benefit_bullets"], "structured", { bullets: ["Fácil de limpar", "Alta durabilidade"] });
    expect(html).toContain("catalogia-bullets");
    expect(html).toContain(">•<");
    expect(html).toContain("Fácil de limpar</span>");
  });

  it("respects the blocks array order regardless of the order fields are supplied in", () => {
    const html = renderPdpHtml(["cta", "description"], "plain", {
      description: "Descrição do produto.",
      cta: "Compre agora",
    });
    expect(html.indexOf("Compre agora")).toBeLessThan(html.indexOf("Descrição do produto"));
  });

  it("skips a block entirely when its data wasn't provided, instead of rendering an empty shell", () => {
    const html = renderPdpHtml(["description", "faq", "cta"], "structured", { description: "Só a descrição." });
    expect(html).not.toContain("catalogia-faq");
    expect(html).not.toContain("catalogia-cta");
  });

  it("only renders the featured image block when featuredImage data exists, even if listed", () => {
    const withImage = renderPdpHtml(["featured_image"], "structured_with_image", {
      featuredImage: { url: "https://example.com/foto.jpg", caption: "Destaque" },
    });
    const withoutImage = renderPdpHtml(["featured_image"], "structured_with_image", {});

    expect(withImage).toContain("https://example.com/foto.jpg");
    expect(withoutImage).toBe("");
  });

  it("renders technical specs as a table on structured levels and inline text on plain", () => {
    const specs = [{ label: "Material", value: "Cerâmica" }];
    const plain = renderPdpHtml(["technical_specs"], "plain", { specs });
    const structured = renderPdpHtml(["technical_specs"], "structured", { specs });

    expect(plain).not.toContain("<table");
    expect(plain).toContain("Material: Cerâmica");
    expect(structured).toContain("<table");
  });

  it("inline-styles the specs table so it reads as a real table even without any theme CSS targeting it", () => {
    // A bare <table> has no default browser border/spacing — confirmed live against a real store
    // theme, it rendered as an unstructured stack of lines without this.
    const html = renderPdpHtml(["technical_specs"], "structured", { specs: [{ label: "Material", value: "Cerâmica" }] });
    expect(html).toMatch(/<table style="[^"]*border-collapse:collapse/);
    expect(html).toMatch(/<td style="[^"]*border:1px solid/);
  });
});

describe("renderPdpHtmlFromTemplate ('modo avançado')", () => {
  it("substitutes each {{placeholder}} with that block's rendered HTML, wherever it appears in the custom markup", () => {
    const template = '<div class="custom"><header>{{cta}}</header><main>{{description}}</main></div>';
    const html = renderPdpHtmlFromTemplate(template, "plain", {
      description: "Descrição do produto.",
      cta: "Compre agora",
    });
    expect(html).toContain('<div class="custom">');
    expect(html.indexOf("Compre agora")).toBeLessThan(html.indexOf("Descrição do produto"));
  });

  it("replaces a placeholder with nothing (not an empty shell) when its data wasn't provided", () => {
    const html = renderPdpHtmlFromTemplate("<section>{{faq}}</section><footer>{{cta}}</footer>", "structured", {
      cta: "Compre agora",
    });
    expect(html).not.toContain("catalogia-faq");
    expect(html).toContain("<section></section><footer>");
    expect(html).toContain("<strong>Compre agora</strong></p></footer>");
  });

  it("leaves an unrecognized {{token}} untouched instead of silently deleting it", () => {
    const html = renderPdpHtmlFromTemplate("<p>{{not_a_real_block}}</p>", "plain", {});
    expect(html).toBe("<p>{{not_a_real_block}}</p>");
  });

  it("still escapes HTML-significant characters inside a substituted block, same as simple mode", () => {
    const html = renderPdpHtmlFromTemplate("<div>{{description}}</div>", "plain", {
      description: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderPdp (mode dispatch)", () => {
  it("uses the blocks list when customHtml is null", () => {
    const html = renderPdp({ blocks: ["description"], customHtml: null }, "plain", { description: "Olá." });
    expect(html).toBe(renderPdpHtml(["description"], "plain", { description: "Olá." }));
  });

  it("uses the custom template when customHtml is set, ignoring the blocks list entirely", () => {
    const html = renderPdp({ blocks: ["cta"], customHtml: "<div>{{description}}</div>" }, "plain", {
      description: "Olá.",
      cta: "Compre agora",
    });
    expect(html).not.toContain("Compre agora");
    expect(html).toContain("Olá.");
  });

  it("uses layout when set and customHtml is null, ignoring the blocks list entirely", () => {
    const layout: PdpLayoutRow[] = [{ columns: [{ block: "cta", align: "center", bold: false, fontSize: "md" }] }];
    const html = renderPdp({ blocks: ["description"], customHtml: null, layout }, "plain", {
      description: "Olá.",
      cta: "Compre agora",
    });
    expect(html).not.toContain("Olá.");
    expect(html).toContain("Compre agora");
  });

  it("prefers customHtml over layout when both are set", () => {
    const layout: PdpLayoutRow[] = [{ columns: [{ block: "cta", align: "center", bold: false, fontSize: "md" }] }];
    const html = renderPdp({ blocks: [], customHtml: "<div>{{description}}</div>", layout }, "plain", {
      description: "Olá.",
      cta: "Compre agora",
    });
    expect(html).toContain("Olá.");
    expect(html).not.toContain("Compre agora");
  });
});

describe("renderPdpLayout ('modo de layout')", () => {
  it("renders a single-column row full width, applying that cell's align/bold/fontSize", () => {
    const layout: PdpLayoutRow[] = [{ columns: [{ block: "cta", align: "center", bold: true, fontSize: "lg" }] }];
    const html = renderPdpLayout(layout, "plain", { cta: "Compre agora" });
    expect(html).toMatch(/text-align:center/);
    expect(html).toMatch(/font-weight:700/);
    expect(html).toMatch(/font-size:1\.2em/);
    expect(html).toContain("Compre agora");
  });

  it("renders a two-column row side by side with each cell keeping its own styling", () => {
    const layout: PdpLayoutRow[] = [
      {
        columns: [
          { block: "benefit_bullets", align: "justify", bold: false, fontSize: "md" },
          { block: "technical_specs", align: "right", bold: false, fontSize: "sm" },
        ],
      },
    ];
    const html = renderPdpLayout(layout, "structured", {
      bullets: ["Resistente"],
      specs: [{ label: "Material", value: "Cerâmica" }],
    });
    expect(html).toContain("display:flex");
    expect(html).toMatch(/text-align:right/);
    expect(html).toContain("Resistente");
    expect(html).toContain("Cerâmica");
  });

  it("collapses a two-column row down to just the populated column when the other cell has no data", () => {
    const layout: PdpLayoutRow[] = [
      {
        columns: [
          { block: "cta", align: "left", bold: false, fontSize: "md" },
          { block: "faq", align: "left", bold: false, fontSize: "md" },
        ],
      },
    ];
    const html = renderPdpLayout(layout, "plain", { cta: "Compre agora" });
    expect(html).not.toContain("display:flex");
    expect(html).toContain("Compre agora");
  });

  it("skips a row entirely when none of its cells have data", () => {
    const layout: PdpLayoutRow[] = [{ columns: [{ block: "faq", align: "left", bold: false, fontSize: "md" }] }];
    expect(renderPdpLayout(layout, "plain", {})).toBe("");
  });
});
