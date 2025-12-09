import { describe, expect, it } from "vitest";
import { parseDxf } from "../utils/dxfParser";
import { ProjectFile, DxfEntity, SemanticLayer } from "../types";
import { calculateSplitRegions } from "../domains/structure/splitService";
import { calculateMergeViews } from "../domains/structure/mergeService";
import { calculateColumns } from "../domains/structure/columnService";
import { calculateWalls } from "../domains/structure/wallService";
import { calculateBeamRawGeneration } from "../domains/structure/beams/beamRawService";
import { calculateBeamIntersectionProcessing } from "../domains/structure/beams/beamIntersectionService";
import { calculateBeamAttributeMounting } from "../domains/structure/beams/beamAttributeService";
import { calculateBeamTopologyMerge } from "../domains/structure/beams/beamTopologyService";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

type Setter<T> = (value: T | ((prev: T) => T)) => void;

type Harness = {
  getActive: () => ProjectFile;
  getProjects: () => ProjectFile[];
  setProjects: Setter<ProjectFile[]>;
  setLayerColors: Setter<Record<string, string>>;
};

const KNOWN_CONFIGS: Record<string, Record<SemanticLayer, string[]>> = {
  "test_beam1.dxf": {
    [SemanticLayer.AXIS]: ["AXIS"],
    [SemanticLayer.AXIS_OTHER]: ["AXIS_DIM", "AXIS_NUM", "AXIS_TEXT"],
    [SemanticLayer.COLUMN]: ["COLU"],
    [SemanticLayer.WALL]: ["WALL"],
    [SemanticLayer.BEAM]: ["BEAM", "BEAM_CON"],
    [SemanticLayer.BEAM_LABEL]: ["Z主楼梁筋(纵向)", "Z主楼梁筋(横向)"],
    [SemanticLayer.BEAM_IN_SITU_LABEL]: ["梁原位标注", "梁原位标注_隐藏"],
    [SemanticLayer.VIEWPORT_TITLE]: ["PUB_TEXT"],
  },
};

const buildLayerConfig = (parsedData: ReturnType<typeof parseDxf>, name: string) => {
  const known = KNOWN_CONFIGS[name];
  if (known) return known;

  const usedLayers = new Set<string>();
  parsedData.entities.forEach((e) => usedLayers.add(e.layer));
  Object.values(parsedData.blocks).forEach((ents) => ents.forEach((e) => usedLayers.add(e.layer)));

  const config: Record<SemanticLayer, string[]> = {
    [SemanticLayer.AXIS]: [],
    [SemanticLayer.AXIS_OTHER]: [],
    [SemanticLayer.COLUMN]: [],
    [SemanticLayer.WALL]: [],
    [SemanticLayer.BEAM]: [],
    [SemanticLayer.BEAM_LABEL]: [],
    [SemanticLayer.BEAM_IN_SITU_LABEL]: [],
    [SemanticLayer.VIEWPORT_TITLE]: []
  };

  parsedData.layers.forEach((layer) => {
    if (!usedLayers.has(layer)) return;
    const lower = layer.toLowerCase();

    if (/axis|grid/.test(lower)) config[SemanticLayer.AXIS].push(layer);
    if (/colu|column/.test(lower)) config[SemanticLayer.COLUMN].push(layer);
    if (/wall/.test(lower)) config[SemanticLayer.WALL].push(layer);
    if (/beam/.test(lower) && !/text|dim|anno|label/.test(lower)) config[SemanticLayer.BEAM].push(layer);
    if (/situ/.test(lower)) config[SemanticLayer.BEAM_IN_SITU_LABEL].push(layer);
    if (/dim|anno|text|label|pub_text/.test(lower)) config[SemanticLayer.BEAM_LABEL].push(layer);
    if (/title|name|view|pub_text/.test(lower)) config[SemanticLayer.VIEWPORT_TITLE].push(layer);
  });

  return config;
};

const createHarness = (parsedData: ReturnType<typeof parseDxf>, name: string): Harness => {
  const layerConfig = buildLayerConfig(parsedData, name);
  let projects: ProjectFile[] = [
    {
      id: `test-${name}`,
      name,
      data: parsedData,
      activeLayers: new Set(parsedData.layers),
      filledLayers: new Set(),
      layerConfig,
      splitRegions: null,
    },
  ];

  let layerColors: Record<string, string> = {};
  parsedData.layers.forEach((layer) => {
    layerColors[layer] = "#ffffff";
  });

  const setProjects: Setter<ProjectFile[]> = (action) => {
    projects = typeof action === "function" ? (action as (prev: ProjectFile[]) => ProjectFile[])(projects) : action;
  };

  const setLayerColors: Setter<Record<string, string>> = (action) => {
    layerColors =
      typeof action === "function" ? (action as (prev: Record<string, string>) => Record<string, string>)(layerColors) : action;
  };

  return {
    getActive: () => projects[0],
    getProjects: () => projects,
    setProjects,
    setLayerColors,
  };
};

const countOnLayer = (entities: DxfEntity[], layer: string) =>
  entities.filter((e) => e.layer.toUpperCase() === layer.toUpperCase()).length;

const mergeEntitiesOntoProject = (
  project: ProjectFile,
  layer: string,
  entities: DxfEntity[]
): ProjectFile => {
  const filtered = project.data.entities.filter((e) => e.layer !== layer);
  const layers = project.data.layers.includes(layer) ? project.data.layers : [layer, ...project.data.layers];
  return {
    ...project,
    data: { ...project.data, entities: [...filtered, ...entities], layers }
  };
};

const mergeExtraLayer = (
  project: ProjectFile,
  layer: string,
  entities: DxfEntity[]
): ProjectFile => {
  const layers = project.data.layers.includes(layer) ? project.data.layers : [layer, ...project.data.layers];
  return {
    ...project,
    data: { ...project.data, entities: [...project.data.entities, ...entities], layers }
  };
};

// --- Local wrappers to apply pure calculations to harness state (no UI) ---
const applySplit = (
  active: ProjectFile,
  setProjects: Setter<ProjectFile[]>,
  setLayerColors: Setter<Record<string, string>>,
  suppressAlert = false
) => {
  const calc = calculateSplitRegions(active, suppressAlert);
  if (!calc) return null;
  const { updatedData, regions, resultLayer, debugLayer } = calc;
  setLayerColors((prev) => ({ ...prev, [resultLayer]: "#FF00FF", [debugLayer]: "#444444" }));
  setProjects((prev) =>
    prev.map((p) => {
      if (p.id === active.id) {
        const newActive = new Set(p.activeLayers);
        newActive.add(resultLayer);
        return { ...p, data: updatedData, splitRegions: regions, activeLayers: newActive };
      }
      return p;
    })
  );
  return regions;
};

const applyMerge = (active: ProjectFile, setProjects: Setter<ProjectFile[]>, setLayerColors: Setter<Record<string, string>>) => {
  const calc = calculateMergeViews(active);
  if (!calc) return;
  const { updatedData, layersAdded, beamLabels } = calc;
  setLayerColors((prev) => {
    const next = { ...prev };
    layersAdded.forEach((l) => (next[l] = next[l] || "#00FFFF"));
    return next;
  });
  setProjects((prev) =>
    prev.map((p) => {
      if (p.id === active.id) {
        const activeLayers = new Set(p.activeLayers);
        layersAdded.forEach((l) => activeLayers.add(l));
        return { ...p, data: updatedData, activeLayers, beamLabels };
      }
      return p;
    })
  );
};

const applyColumns = (
  active: ProjectFile,
  setProjects: Setter<ProjectFile[]>,
  setLayerColors: Setter<Record<string, string>>
) => {
  const calc = calculateColumns(active);
  if (!calc) return;
  setProjects((prev) =>
    prev.map((p) => {
      if (p.id !== active.id) return p;
      const updated = mergeEntitiesOntoProject(p, calc.resultLayer, calc.entities);
      const activeLayers = new Set(updated.activeLayers);
      activeLayers.add(calc.resultLayer);
      return { ...updated, activeLayers, columns: calc.infos };
    })
  );
};

const applyWalls = (
  active: ProjectFile,
  setProjects: Setter<ProjectFile[]>,
  setLayerColors: Setter<Record<string, string>>
) => {
  const calc = calculateWalls(active);
  if (!calc) return;
  setProjects((prev) =>
    prev.map((p) => {
      if (p.id !== active.id) return p;
      const updated = mergeEntitiesOntoProject(p, calc.resultLayer, calc.entities);
      const activeLayers = new Set(updated.activeLayers);
      activeLayers.add(calc.resultLayer);
      return { ...updated, activeLayers, walls: calc.infos };
    })
  );
};

const applyBeamStep1 = (
  active: ProjectFile,
  projects: ProjectFile[],
  setProjects: Setter<ProjectFile[]>,
  setLayerColors: Setter<Record<string, string>>
) => {
  const calc = calculateBeamRawGeneration(active, projects);
  if (!calc) return;
  setProjects((prev) =>
    prev.map((p) => {
      if (p.id !== active.id) return p;
      const updated = mergeEntitiesOntoProject(p, calc.resultLayer, calc.entities);
      const activeLayers = new Set(updated.activeLayers);
      activeLayers.add(calc.resultLayer);
      return { ...updated, activeLayers };
    })
  );
};

const applyBeamStep2 = (
  active: ProjectFile,
  projects: ProjectFile[],
  setProjects: Setter<ProjectFile[]>,
  setLayerColors: Setter<Record<string, string>>
) => {
  const calc = calculateBeamIntersectionProcessing(active, projects);
  if (!calc) return;
  setProjects((prev) =>
    prev.map((p) => {
      if (p.id !== active.id) return p;
      let updated = mergeEntitiesOntoProject(p, calc.resultLayer, calc.entities);
      updated = mergeExtraLayer(updated, calc.interLayer, calc.interEntities);
      const activeLayers = new Set(updated.activeLayers);
      activeLayers.add(calc.resultLayer);
      activeLayers.add(calc.interLayer);
      return { ...updated, activeLayers, beamStep2GeoInfos: calc.geoInfos, beamStep2InterInfos: calc.interInfos };
    })
  );
};

const applyBeamStep3 = (
  active: ProjectFile,
  projects: ProjectFile[],
  setProjects: Setter<ProjectFile[]>,
  setLayerColors: Setter<Record<string, string>>
) => {
  const calc = calculateBeamAttributeMounting(active, projects);
  if (!calc) return;
  setProjects((prev) =>
    prev.map((p) => {
      if (p.id !== active.id) return p;
      const updated = mergeEntitiesOntoProject(p, calc.resultLayer, calc.entities);
      const activeLayers = new Set(updated.activeLayers);
      activeLayers.add(calc.resultLayer);
      activeLayers.add(calc.debugLayer);
      return { ...updated, activeLayers, beamStep3AttrInfos: calc.infos };
    })
  );
};

const applyBeamStep4 = (
  active: ProjectFile,
  projects: ProjectFile[],
  setProjects: Setter<ProjectFile[]>,
  setLayerColors: Setter<Record<string, string>>
) => {
  const calc = calculateBeamTopologyMerge(active, projects);
  if (!calc) return;
  setProjects((prev) =>
    prev.map((p) => {
      if (p.id !== active.id) return p;
      const updated = mergeEntitiesOntoProject(p, calc.resultLayer, calc.entities);
      const activeLayers = new Set(updated.activeLayers);
      activeLayers.add(calc.resultLayer);
      return { ...updated, activeLayers, beamStep4TopologyInfos: calc.infos };
    })
  );
};

describe("structure integration suite", () => {
  it("processes test_beam1.dxf through the full pipeline", async () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.join(testDir, "data", "test_beam1.dxf");
    const buffer = fs.readFileSync(fixturePath);
    const decodeBufferBestEffort = (buf: Buffer) => {
      const preferred = ["utf-8", "gb18030", "gbk", "big5", "shift_jis", "windows-1252"];
      const codepageMap: Record<string, string> = {
        ANSI_936: "gb18030",
        ANSI_1252: "windows-1252",
        UTF8: "utf-8",
        "UTF-8": "utf-8",
      };
      const extractCodepage = (raw: Buffer): string | null => {
        try {
          const ascii = new TextDecoder("ascii", { fatal: false }).decode(raw);
          const match = ascii.match(/\$DWGCODEPAGE\s*[\r\n]+\s*3\s*[\r\n]+([A-Za-z0-9_]+)/i);
          return match ? match[1].trim() : null;
        } catch {
          return null;
        }
      };
      const codepage = extractCodepage(buf);
      const hinted = codepage ? codepageMap[codepage.toUpperCase()] : undefined;
      const candidates = hinted ? [hinted, ...preferred] : preferred;
      const seen = new Set<string>();
      let best = { text: "", enc: "utf-8", quality: -Infinity, repl: Number.POSITIVE_INFINITY };
      candidates.forEach((enc) => {
        if (!enc || seen.has(enc)) return;
        seen.add(enc);
        try {
          const dec = new TextDecoder(enc as any, { fatal: false });
          const text = dec.decode(buf);
          const replacements = (text.match(/\uFFFD/g) || []).length;
          const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
          const quality = cjkCount / (1 + replacements);
          if (quality > best.quality || (quality === best.quality && replacements < best.repl)) {
            best = { text, enc, quality, repl: replacements };
          }
        } catch {
          // ignore unsupported enc
        }
      });
      if (best.text === "") {
        best.text = new TextDecoder().decode(buf);
        best.enc = "utf-8";
      }
      return best;
    };

    const { text: decoded, enc: usedEnc } = decodeBufferBestEffort(buffer);
    const parsed = parseDxf(decoded, usedEnc);
    const harness = createHarness(parsed, "test_beam1.dxf");
    const { getActive, getProjects, setProjects, setLayerColors } = harness;

    expect(parsed.layers.length).toBeGreaterThan(0);
    expect(parsed.entities.length).toBeGreaterThan(0);

    const regions = applySplit(getActive(), setProjects, setLayerColors, true);
    expect(regions?.length ?? 0).equal(3);
    expect(getActive().splitRegions?.length ?? 0).toBeGreaterThan(0);

    applyMerge(getActive(), setProjects, setLayerColors);
    const mergedLayers = getActive().data.layers.filter((i) => i.startsWith("MERGE_LABEL"));
    expect(mergedLayers.length).equal(2);
    expect(getActive().beamLabels?.length ?? 0).equal(203);

    applyColumns(getActive(), setProjects, setLayerColors);
    const columnCount = countOnLayer(getActive().data.entities, "COLU_CALC");
    expect(columnCount).equal(10);

    applyWalls(getActive(), setProjects, setLayerColors);
    const wallCount = countOnLayer(getActive().data.entities, "WALL_CALC");
    expect(wallCount).equal(63);

    applyBeamStep1(getActive(), getProjects(), setProjects, setLayerColors);
    const rawBeams = countOnLayer(getActive().data.entities, "BEAM_STEP1_RAW");
    expect(rawBeams).equal(122);

    applyBeamStep2(getActive(), getProjects(), setProjects, setLayerColors);
    const step2Beams = getActive().beamStep2GeoInfos?.length ?? 0;
    const interCount = getActive().beamStep2InterInfos?.length ?? 0;
    expect(step2Beams).equal(88);
    expect(interCount).equal(63);

    applyBeamStep3(getActive(), getProjects(), setProjects, setLayerColors);
    const step3Attrs = getActive().beamStep3AttrInfos?.length ?? 0;
    const codeCounts = (getActive().beamStep3AttrInfos || []).reduce<Record<string, number>>((acc, info) => {
      const key = info.code || "(empty)";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    expect(step3Attrs).equal(88);
    expect(codeCounts["WKL4"] ?? 0).equal(1);
    expect(codeCounts["WKL10"] ?? 0).equal(5);
    expect(codeCounts["WKL8"] ?? 0).equal(7);
    expect(codeCounts["KL1"] ?? 0).equal(1);

    applyBeamStep4(getActive(), getProjects(), setProjects, setLayerColors);
    const step4Topology = getActive().beamStep4TopologyInfos?.length ?? 0;
    const topoCodeCounts = (getActive().beamStep4TopologyInfos || []).reduce<Record<string, number>>((acc, info) => {
      const key = info.code || "(empty)";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    expect(step4Topology).equal(100);
    expect(topoCodeCounts["WKL10"] ?? 0).equal(5);
    expect(topoCodeCounts["WKL8"] ?? 0).equal(7);
    expect(topoCodeCounts["WKL4"] ?? 0).equal(1);
    expect(topoCodeCounts["KL1"] ?? 0).equal(2);
    expect(topoCodeCounts["L10"] ?? 0).equal(8);
    expect(topoCodeCounts["KL4"] ?? 0).equal(2);
    expect(topoCodeCounts["KL6"] ?? 0).equal(2);
    expect(topoCodeCounts["L10"] ?? 0).equal(8);
    expect(topoCodeCounts["L13"] ?? 0).equal(2);
    expect(topoCodeCounts["(empty)"] ?? 0).equal(0);

    const l13Lengths = (getActive().beamStep4TopologyInfos || [])
      .filter((info) => info.code === "L13")
      .map((info) => Math.round(info.length || 0))
      .sort((a, b) => a - b);
    expect(l13Lengths).deep.equal([2760, 3120]);
  });
});
