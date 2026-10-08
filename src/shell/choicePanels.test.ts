// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMapSourcePanel, type MapSourceStatus } from "./mapSourcePanel";
import { createRendererPanel } from "./rendererPanel";
import { createSkyPanel } from "./skyPanel";
import { fixedTimeValues } from "./dateTimePanel";
import { solarPosition } from "../sky/solarPosition";
import { getAppSettings } from "../settings/appSettings";

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
  it("leaves exposure and the fill light to the Sky tab", () => {
    const settings = getAppSettings();
    const panel = createRendererPanel({ renderer: { mode: "webgl2", requested: "auto" }, settings, onChange: vi.fn() });
    try {
      expect(panel.element.textContent).not.toContain("Lighting and exposure");
      for (const id of ["renderer.exposureEV", "renderer.ambientFillMultiplier"]) {
        expect(panel.element.querySelectorAll(`[data-parameter="${id}"]`)).toHaveLength(0);
      }
    } finally { panel.destroy(); }
  });

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

describe("Sky tab", () => {
  const MINNEAPOLIS = { latDeg: 44.977753, lonDeg: -93.265011 };

  it("homes atmosphere, the Moon and stars, the ground, night lights and exposure once each, with the controls that were the Renderer tab's", () => {
    const settings = getAppSettings();
    const panel = createSkyPanel({ settings, getPlace: () => MINNEAPOLIS });
    document.body.append(panel.element);
    try {
      expect([...panel.element.querySelectorAll<HTMLElement>("[data-section]")].map(element => element.dataset.section))
        .toEqual(["sky.atmosphere", "sky.night", "sky.surface", "sky.nightLights", "sky.exposure"]);
      expect(panel.element.textContent).toContain("Exposure and display");
      // The sky is on unless turned off; the fill light is a control only while it is off.
      expect(panel.element.querySelector('[data-parameter="renderer.ambientFillMultiplier"]')).toBeNull();
      settings.set("sky.model", "off");
      // The values saved under the Renderer tab's ids are these controls' values.
      for (const [id, section, initial, next] of [["renderer.exposureEV", "sky/exposure", 0, 2], ["renderer.ambientFillMultiplier", "sky/atmosphere", 1, 0]] as const) {
        expect(panel.element.querySelectorAll(`[data-parameter="${id}"]`)).toHaveLength(1);
        const control = panel.element.querySelector(`[data-settings-section="${section}"] [data-parameter="${id}"]`)!;
        const field = control.querySelector<HTMLInputElement>('input[type="number"]')!;
        expect(Number(field.value)).toBe(initial);
        expect(control.querySelector('input[type="range"]')).not.toBeNull();
        field.value = String(next);
        field.dispatchEvent(new Event("change", { bubbles: true }));
        expect(settings.get(id)).toBe(next);
      }
      // The time is the Date and time tab's: none of its controls are here. The fill light shows only while no sky model lights the scene.
      settings.setMany({ "sky.time.mode": "fixed", "sky.model": "dome" });
      expect(panel.element.querySelector('[data-parameter^="sky.time."]')).toBeNull();
      expect(panel.element.querySelector('[data-parameter="renderer.ambientFillMultiplier"]')).toBeNull();
      expect(panel.element.querySelector('[data-parameter="sky.exposure.meterRange"]')).not.toBeNull();
      expect(panel.element.querySelector('[data-parameter="sky.exposure.ev100"]')).toBeNull();
    } finally {
      panel.destroy();
      settings.resetAll({ tab: "sky" });
      settings.resetAll({ tab: "time" });
    }
  });

  it("says where the Sun is at the time in use, and links to the tab that sets it", () => {
    const settings = getAppSettings();
    let place: { latDeg: number; lonDeg: number } | null = null;
    const openDateTime = vi.fn();
    const panel = createSkyPanel({ settings, getPlace: () => place, now: () => Date.UTC(2026, 9, 7, 20, 0), openDateTime });
    document.body.append(panel.element);
    try {
      expect(panel.element.textContent).toContain("The place shown is not known yet.");
      place = MINNEAPOLIS;
      settings.setMany(fixedTimeValues(Date.UTC(2026, 9, 7, 23, 41)));
      // About 18:41 Central Daylight Time, sunset: the Sun's disc on the horizon, in the west-south-west.
      const sun = solarPosition({ utcMs: Date.UTC(2026, 9, 7, 23, 41), ...MINNEAPOLIS });
      expect(panel.element.textContent).toContain(`At the set time, 17:40 solar time on 2026-10-07, the Sun is ${Math.abs(90 - sun.zenithDeg).toFixed(1)}°`);
      expect(panel.element.textContent).toMatch(/bearing 26\d°/);
      const link = [...panel.element.querySelectorAll("button")].find(button => button.textContent === "Date and time")!;
      link.click();
      expect(openDateTime).toHaveBeenCalledTimes(1);
      settings.set("sky.time.mode", "now");
      expect(panel.element.textContent).toContain("Now, 13:59 solar time on 2026-10-07, the Sun is");
    } finally {
      panel.destroy();
      settings.resetAll({ tab: "time" });
    }
    // A host that has no Date and time tab gets the line and no link.
    const plain = createSkyPanel({ settings, getPlace: () => MINNEAPOLIS });
    expect([...plain.element.querySelectorAll("button")].some(button => button.textContent === "Date and time")).toBe(false);
    plain.destroy();
  });
});
