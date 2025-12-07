import { describe, expect, it } from "vitest";
import { parseDxf } from "../utils/dxfParser";
import { ProjectFile, DxfEntity, SemanticLayer } from "../types";
import {
  runCalculateSplitRegions,
  runMergeViews,
  runCalculateColumns,
  runCalculateWalls,
  runBeamRawGeneration,
  runBeamIntersectionProcessing,
  runBeamAttributeMounting,
  runBeamTopologyMerge,
} from "../domains/structure";
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
  "配筋简图.dxf": {
    [SemanticLayer.AXIS]: ["AXIS", "AXIS_DIM", "AXIS_NUM", "AXIS_TEXT"],
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

describe("structure integration suite", () => {
  it("processes 配筋简图.dxf through the full pipeline", async () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.join(testDir, "data", "配筋简图.dxf");
    const buffer = fs.readFileSync(fixturePath);
    const decodeBufferBestEffort = (buf: Buffer) => {
      const preferred = ["utf-8", "gb18030", "gbk", "big5", "shift_jis", "windows-1252"];
      const seen = new Set<string>();
      let best = { text: "", enc: "utf-8", score: Number.POSITIVE_INFINITY };
      preferred.forEach((enc) => {
        if (!enc || seen.has(enc)) return;
        seen.add(enc);
        try {
          const dec = new TextDecoder(enc as any, { fatal: false });
          const text = dec.decode(buf);
          const score = (text.match(/\uFFFD/g) || []).length;
          if (score < best.score) {
            best = { text, enc, score };
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
    const harness = createHarness(parsed, "配筋简图.dxf");
    const { getActive, getProjects, setProjects, setLayerColors } = harness;

    expect(parsed.layers.length).toBeGreaterThan(0);
    expect(parsed.entities.length).toBeGreaterThan(0);

    const regions = runCalculateSplitRegions(getActive(), setProjects, setLayerColors, true);
    expect(regions?.length ?? 0).equal(3);
    expect(getActive().splitRegions?.length ?? 0).toBeGreaterThan(0);

    runMergeViews(getActive(), setProjects, setLayerColors);
    const mergedLayers = getActive().data.layers.filter((i) => i.startsWith("MERGE_LABEL"));
    expect(mergedLayers.length).equal(2);
    expect(getActive().beamLabels?.length ?? 0).equal(203);

    runCalculateColumns(getActive(), getProjects(), setProjects, setLayerColors);
    const columnCount = countOnLayer(getActive().data.entities, "COLU_CALC");
    expect(columnCount).equal(10);

    runCalculateWalls(getActive(), getProjects(), setProjects, setLayerColors);
    const wallCount = countOnLayer(getActive().data.entities, "WALL_CALC");
    expect(wallCount).equal(63);

    runBeamRawGeneration(getActive(), getProjects(), setProjects, setLayerColors);
    const rawBeams = countOnLayer(getActive().data.entities, "BEAM_STEP1_RAW");
    expect(rawBeams).equal(122);

    runBeamIntersectionProcessing(getActive(), getProjects(), setProjects, setLayerColors);
    const step2Beams = getActive().beamStep2GeoInfos?.length ?? 0;
    const interCount = getActive().beamStep2InterInfos?.length ?? 0;
    expect(step2Beams).equal(88);
    expect(interCount).equal(63);

    runBeamAttributeMounting(getActive(), getProjects(), setProjects, setLayerColors);
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

    runBeamTopologyMerge(getActive(), getProjects(), setProjects, setLayerColors);
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
    expect(topoCodeCounts["(empty)"] ?? 0).equal(0);
  });
});
