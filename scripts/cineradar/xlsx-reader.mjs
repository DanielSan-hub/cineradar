import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import { strFromU8, unzipSync } from "fflate";

const MAX_WORKBOOK_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const XML_PREFIX = "(?:[A-Za-z_][\\w.-]*:)?";

function decodeXml(value) {
  return String(value ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function attributes(fragment) {
  const result = {};
  const pattern = /([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  for (const match of fragment.matchAll(pattern)) result[match[1]] = decodeXml(match[3]);
  return result;
}

function tagBody(xml, localName) {
  const pattern = new RegExp(
    `<${XML_PREFIX}${localName}\\b[^>]*>([\\s\\S]*?)<\\/${XML_PREFIX}${localName}\\s*>`,
    "i",
  );
  return pattern.exec(xml)?.[1] ?? null;
}

function richText(xml) {
  const values = [];
  const pattern = new RegExp(
    `<${XML_PREFIX}t\\b[^>]*>([\\s\\S]*?)<\\/${XML_PREFIX}t\\s*>`,
    "gi",
  );
  for (const match of xml.matchAll(pattern)) values.push(decodeXml(match[1]));
  return values.join("");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const values = [];
  const pattern = new RegExp(
    `<${XML_PREFIX}si\\b[^>]*>([\\s\\S]*?)<\\/${XML_PREFIX}si\\s*>`,
    "gi",
  );
  for (const match of xml.matchAll(pattern)) values.push(richText(match[1]));
  return values;
}

function columnIndex(reference) {
  const letters = /^([A-Z]+)/i.exec(reference)?.[1]?.toUpperCase();
  if (!letters) return null;
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function cellValue(body, type, sharedStrings) {
  if (type === "inlineStr") return richText(tagBody(body, "is") ?? body);
  const raw = tagBody(body, "v");
  if (raw === null) return null;
  const value = decodeXml(raw);
  if (type === "s") {
    const index = Number.parseInt(value, 10);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) {
      throw new Error(`Invalid shared-string index: ${value}`);
    }
    return sharedStrings[index];
  }
  if (type === "b") return value === "1";
  if (type === "str" || type === "e" || type === "d") return value;
  if (value.trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function parseWorksheet(xml, sharedStrings, name) {
  const rows = [];
  const rowPattern = new RegExp(
    `<${XML_PREFIX}row\\b([^>]*)>([\\s\\S]*?)<\\/${XML_PREFIX}row\\s*>`,
    "gi",
  );
  let fallbackRow = 0;
  for (const rowMatch of xml.matchAll(rowPattern)) {
    const rowAttributes = attributes(rowMatch[1]);
    const rowNumber = Number.parseInt(rowAttributes.r, 10) || fallbackRow + 1;
    fallbackRow = rowNumber;
    const cells = [];
    const values = [];
    let fallbackColumn = 0;
    const cellPattern = new RegExp(
      `<${XML_PREFIX}c\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/${XML_PREFIX}c\\s*>)`,
      "gi",
    );
    for (const cellMatch of rowMatch[2].matchAll(cellPattern)) {
      const cellAttributes = attributes(cellMatch[1]);
      const reference = cellAttributes.r ?? null;
      const index = reference ? columnIndex(reference) : fallbackColumn;
      if (index === null || index < 0 || index > 16_383) {
        throw new Error(`Invalid cell reference in sheet ${name}: ${reference ?? "(missing)"}`);
      }
      fallbackColumn = index + 1;
      const body = cellMatch[2] ?? "";
      const value = cellValue(body, cellAttributes.t, sharedStrings);
      const formula = tagBody(body, "f");
      values[index] = value;
      cells.push({
        reference: reference ?? null,
        column: index,
        type: cellAttributes.t ?? "n",
        style: cellAttributes.s === undefined ? null : Number(cellAttributes.s),
        formula: formula === null ? null : decodeXml(formula),
        value,
      });
    }
    rows.push({ number: rowNumber, cells, values });
  }
  return {
    name,
    rows,
    maxColumn: rows.reduce((maximum, row) => Math.max(maximum, row.values.length), 0),
  };
}

function archivePath(workbookPath, target) {
  if (target.startsWith("/")) return posix.normalize(target.slice(1));
  return posix.normalize(posix.join(posix.dirname(workbookPath), target));
}

function workbookRelationships(xml, workbookPath) {
  const relationships = new Map();
  const pattern = new RegExp(`<${XML_PREFIX}Relationship\\b([^>]*)\\/?>`, "gi");
  for (const match of xml.matchAll(pattern)) {
    const value = attributes(match[1]);
    if (value.Id && value.Target) {
      relationships.set(value.Id, archivePath(workbookPath, value.Target));
    }
  }
  return relationships;
}

function workbookSheets(xml) {
  const sheets = [];
  const pattern = new RegExp(`<${XML_PREFIX}sheet\\b([^>]*)\\/?>`, "gi");
  for (const match of xml.matchAll(pattern)) {
    const value = attributes(match[1]);
    const relationshipId = value["r:id"] ?? value.id;
    if (value.name && relationshipId) sheets.push({ name: value.name, relationshipId });
  }
  return sheets;
}

function zipText(archive, path, { required = false } = {}) {
  const bytes = archive[path];
  if (!bytes) {
    if (required) throw new Error(`Malformed XLSX: missing ${path}`);
    return null;
  }
  return strFromU8(bytes);
}

function validateArchiveSize(archive) {
  const total = Object.values(archive).reduce((sum, value) => sum + value.byteLength, 0);
  if (total > MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`Malformed XLSX: uncompressed content exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`);
  }
}

export function readXlsxBuffer(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("Malformed XLSX: expected a ZIP-based workbook");
  }
  let archive;
  try {
    archive = unzipSync(bytes);
  } catch (error) {
    throw new Error(`Malformed XLSX archive: ${error.message}`, { cause: error });
  }
  validateArchiveSize(archive);

  const workbookPath = "xl/workbook.xml";
  const workbookXml = zipText(archive, workbookPath, { required: true });
  const relationshipsXml = zipText(archive, "xl/_rels/workbook.xml.rels", { required: true });
  const sharedStrings = parseSharedStrings(zipText(archive, "xl/sharedStrings.xml"));
  const relationships = workbookRelationships(relationshipsXml, workbookPath);
  const definitions = workbookSheets(workbookXml);
  if (!definitions.length) throw new Error("Malformed XLSX: workbook has no sheets");

  const sheets = definitions.map(({ name, relationshipId }) => {
    const path = relationships.get(relationshipId);
    if (!path) throw new Error(`Malformed XLSX: no relationship target for sheet ${name}`);
    return parseWorksheet(zipText(archive, path, { required: true }), sharedStrings, name);
  });
  return {
    sheetNames: sheets.map((sheet) => sheet.name),
    sheets,
  };
}

export async function readXlsx(path) {
  const input = await readFile(path);
  if (input.byteLength > MAX_WORKBOOK_BYTES) {
    throw new Error(`Malformed XLSX: file exceeds ${MAX_WORKBOOK_BYTES} bytes`);
  }
  return readXlsxBuffer(input);
}

export function getSheet(workbook, name) {
  return workbook.sheets.find((sheet) => sheet.name === name) ?? null;
}

export function sheetToObjects(sheet, { headerRow } = {}) {
  if (!sheet) throw new Error("Cannot convert a missing worksheet");
  const header = headerRow === undefined
    ? sheet.rows.find((row) => row.values.some((value) => value !== null && value !== undefined && value !== ""))
    : sheet.rows.find((row) => row.number === headerRow);
  if (!header) throw new Error(`Worksheet ${sheet.name} has no header row`);

  const seen = new Map();
  const headers = header.values.map((value) => {
    const base = String(value ?? "").trim();
    if (!base) return null;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });

  return sheet.rows
    .filter((row) => row.number > header.number)
    .map((row) => Object.fromEntries(
      headers
        .map((name, index) => [name, row.values[index]])
        .filter(([name, value]) => name && value !== null && value !== undefined && value !== ""),
    ))
    .filter((row) => Object.keys(row).length > 0);
}
