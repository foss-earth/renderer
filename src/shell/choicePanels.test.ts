// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMapSourcePanel, type MapSourceStatus } from "./mapSourcePanel";
import { createRendererPanel } from "./rendererPanel";

afterEach(() => document.body.replaceChildren());

const raster = { id: "osm", label: "OpenStreetMap", attributionUrl: "https://www.openstreetmap.org/copyright" };
const status = (mode: MapSourceStatus["mode"], terrain = "mapterhorn"): MapSourceStatus => ({
  mode,
  rasterBaseMap: mode === "raster-basemap" ? { ...raster } as MapSourceStatus["rasterBaseMap"] : null,
  terrainSource: { id: terrain } as MapSourceStatus["terrainSource"],
});

describe("Map tab", () => {
  function mount() {
    const onMapSourceChange = vi.fn();
    const onTerrainSourceChange = vi.fn();
    const panel = createMapSourcePanel({
      rasterSources: [raster, { id: "topo", label: "Topo", attributionUrl: "https://opentopomap.org/about" }],
      terrainSources: [
        { id: "mapterhorn", label: "Mapterhorn", attribution: "https://mapterhorn.com/attribution/" },
        { id: "aws-terrarium", label: "Terrarium", attribution: "https://registry.opendata.aws/terrain-tiles/" },
      ],
      onMapSourceChange,
      onTerrainSourceChange,
    });
    document.body.append(panel.element);
    const checked = (name: string) => panel.element.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null;
    const group = (label: string) => panel.element.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    return { panel, onMapSourceChange, onTerrainSourceChange, checked, group };
  }

  it("offers the elevation provider only while a 2D basemap is showing", () => {
    const { panel, checked, group } = mount();
    panel.update(status("raster-basemap"));
    expect(checked("foss-earth-map-source")).toBe("osm");
    expect(checked("foss-earth-elevation-source")).toBe("mapterhorn");
    expect(group("Elevation provider").hidden).toBe(false);
    expect(group("3D basemaps").querySelector("p")!.hidden).toBe(true);
    expect(group("Elevation provider").querySelector("p")).toBeNull();

    panel.update(status("google-tiles"));
    expect(checked("foss-earth-map-source")).toBe("google");
    expect(group("Elevation provider").hidden).toBe(true);
    expect(group("3D basemaps").querySelector("p")!.hidden).toBe(false);

    panel.update(status("fallback"));
    expect(checked("foss-earth-map-source")).toBeNull();
  });

  it("ends only the pills in use with a link to their attribution pages, and no text", () => {
    const { panel } = mount();
    const shownCredits = () => [...panel.element.querySelectorAll<HTMLAnchorElement>("label.foss-earth-choice > a")]
      .filter((credit) => credit.closest("[hidden]") === null);
    const shownHrefs = () => shownCredits().map((credit) => credit.href);

    panel.update(status("raster-basemap"));
    expect(shownHrefs()).toEqual(["https://www.openstreetmap.org/copyright", "https://mapterhorn.com/attribution/"]);
    for (const credit of shownCredits()) {
      expect(credit.textContent).toBe("");
      expect(credit.querySelector("svg.foss-earth-external-link-icon")).not.toBeNull();
      expect(credit.target).toBe("_blank");
    }
    expect(shownCredits()[1]!.getAttribute("aria-label")).toBe("Mapterhorn attribution, opens in a new tab");

    panel.update(status("raster-basemap", "aws-terrarium"));
    expect(shownHrefs()).toEqual(["https://www.openstreetmap.org/copyright", "https://registry.opendata.aws/terrain-tiles/"]);

    panel.update(status("google-tiles"));
    expect(shownHrefs()).toEqual(["https://www.google.com/help/legalnotices_maps/"]);

    panel.update(status("fallback"));
    expect(shownHrefs()).toEqual([]);
  });

  it("reports a choice, and goes back to what the runtime uses if the switch does not happen", () => {
    const { panel, onMapSourceChange, onTerrainSourceChange, checked } = mount();
    panel.update(status("raster-basemap"));

    panel.element.querySelector<HTMLInputElement>('input[value="topo"]')!.click();
    expect(onMapSourceChange).toHaveBeenCalledWith("topo");
    panel.update(status("raster-basemap"));
    expect(checked("foss-earth-map-source")).toBe("osm");

    panel.element.querySelector<HTMLInputElement>('input[value="aws-terrarium"]')!.click();
    expect(onTerrainSourceChange).toHaveBeenCalledWith("aws-terrarium");
  });

  it("leaves the elevation provider out when the host cannot change it", () => {
    const panel = createMapSourcePanel({ rasterSources: [raster], terrainSources: [raster], onMapSourceChange: vi.fn() });
    expect(panel.element.querySelector('[aria-label="Elevation provider"]')).toBeNull();
  });
});

describe("Renderer tab", () => {
  it("says a chosen renderer did not start, and shows why", () => {
    const panel = createRendererPanel({
      renderer: {
        mode: "webgl2",
        requested: "webgpu",
        fallbackReason: "adapter lost",
        diagnostics: { navigatorGpuPresent: true, isSupportedAsyncResult: false, isSecureContext: true },
      },
      onChange: vi.fn(),
    });
    expect(panel.element.textContent).toContain("Running on WebGL2. WebGPU was chosen but did not start.");
    expect(panel.element.querySelector<HTMLInputElement>("input:checked")?.value).toBe("webgpu");
    expect(panel.element.querySelector(".foss-earth-renderer-diagnostics")?.textContent).toContain("Error: adapter lost");
  });

  it("reports auto-detect as no forced renderer", () => {
    const onChange = vi.fn();
    const panel = createRendererPanel({ renderer: { mode: "webgpu", requested: "webgpu" }, onChange });
    document.body.append(panel.element);
    expect(panel.element.querySelector(".foss-earth-renderer-diagnostics")).toBeNull();

    panel.element.querySelector<HTMLInputElement>('input[value="auto"]')!.click();
    expect(onChange).toHaveBeenLastCalledWith(null);
    panel.element.querySelector<HTMLInputElement>('input[value="webgl"]')!.click();
    expect(onChange).toHaveBeenLastCalledWith("webgl");
  });
});
