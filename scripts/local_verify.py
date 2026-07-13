from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = {
    'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'rel': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'pkg': 'http://schemas.openxmlformats.org/package/2006/relationships',
}


def col_to_index(col: str) -> int:
    n = 0
    for ch in col:
        if ch.isalpha():
            n = n * 26 + ord(ch.upper()) - 64
    return n - 1


def normalize(text: Any) -> str:
    return re.sub(r'\s+', '', str(text or '')).lower()


@dataclass
class SheetData:
    name: str
    headers: list[str]
    rows: list[dict[str, str]]


class XlsxReader:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.zip = ZipFile(path)
        self.shared_strings = self._load_shared_strings()
        self.sheet_map = self._load_sheet_map()

    def _load_shared_strings(self) -> list[str]:
        if 'xl/sharedStrings.xml' not in self.zip.namelist():
            return []
        root = ET.fromstring(self.zip.read('xl/sharedStrings.xml'))
        values = []
        for si in root.findall('main:si', NS):
            parts = [node.text or '' for node in si.findall('.//main:t', NS)]
            values.append(''.join(parts))
        return values

    def _load_sheet_map(self) -> dict[str, str]:
        wb = ET.fromstring(self.zip.read('xl/workbook.xml'))
        rels = ET.fromstring(self.zip.read('xl/_rels/workbook.xml.rels'))
        rel_map = {rel.attrib['Id']: rel.attrib['Target'] for rel in rels.findall('pkg:Relationship', NS)}
        sheet_map = {}
        for sheet in wb.findall('main:sheets/main:sheet', NS):
            rid = sheet.attrib.get('{%s}id' % NS['rel'])
            target = rel_map.get(rid, '')
            if target:
                sheet_map[sheet.attrib['name']] = 'xl/' + target.lstrip('./')
        return sheet_map

    def read_sheet(self, sheet_name: str | None = None) -> SheetData:
        if not self.sheet_map:
            raise ValueError('工作簿内没有可读取的 sheet')
        name = sheet_name or next(iter(self.sheet_map))
        if name not in self.sheet_map:
            raise ValueError(f'未找到 sheet: {name}')
        root = ET.fromstring(self.zip.read(self.sheet_map[name]))
        rows_raw: list[list[str]] = []
        for row in root.findall('main:sheetData/main:row', NS):
            values: list[str] = []
            for cell in row.findall('main:c', NS):
                ref = cell.attrib.get('r', '')
                letters = ''.join(ch for ch in ref if ch.isalpha())
                idx = col_to_index(letters) if letters else len(values)
                while len(values) < idx:
                    values.append('')
                values.append(self._cell_value(cell))
            rows_raw.append(values)
        rows_raw = [r for r in rows_raw if any(v != '' for v in r)]
        if not rows_raw:
            return SheetData(name=name, headers=[], rows=[])
        width = max(len(r) for r in rows_raw)
        padded = [r + [''] * (width - len(r)) for r in rows_raw]
        headers = [f'列{i + 1}' for i in range(width)]
        data_rows = []
        for raw in padded:
            item = {headers[i]: str(raw[i] or '') for i in range(width)}
            if any(item.values()):
                data_rows.append(item)
        return SheetData(name=name, headers=headers, rows=data_rows)


    def _cell_value(self, cell: ET.Element) -> str:
        t = cell.attrib.get('t')
        if t == 'inlineStr':
            node = cell.find('main:is/main:t', NS)
            return node.text if node is not None and node.text else ''
        v = cell.find('main:v', NS)
        if v is None or v.text is None:
            return ''
        if t == 's':
            idx = int(v.text)
            return self.shared_strings[idx] if idx < len(self.shared_strings) else ''
        return v.text


def load_tasks(path: Path) -> list[str]:
    tasks = []
    with path.open('r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            task = item.get('task')
            if task:
                tasks.append(str(task))
    return tasks


def build_corpus(sheet: SheetData) -> list[str]:
    rows = []
    for row in sheet.rows:
        cell_values = [normalize(v) for v in row.values() if normalize(v)]
        if cell_values:
            rows.extend(cell_values)
            rows.append(' '.join(cell_values))
    return rows


def compare(tasks: list[str], sheet: SheetData) -> dict[str, Any]:
    corpus = build_corpus(sheet)
    matched = []
    unmatched = []
    for task in tasks:
        value = normalize(task)
        hit = any(value and value in text for text in corpus)
        (matched if hit else unmatched).append(task)
    total = len(tasks)
    matched_count = len(matched)
    ratio = round((matched_count / total) * 100, 2) if total else 0.0
    return {
        'sheet': sheet.name,
        'headers': sheet.headers,
        'rowCount': len(sheet.rows),
        'taskCount': total,
        'matchedCount': matched_count,
        'unmatchedCount': len(unmatched),
        'matchRatio': ratio,
        'allMatched': matched_count == total,
        'matchedPreview': matched[:10],
        'unmatchedPreview': unmatched[:10],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--xlsx', required=True)
    parser.add_argument('--jsonl', required=True)
    parser.add_argument('--sheet')
    args = parser.parse_args()

    reader = XlsxReader(Path(args.xlsx))
    sheet = reader.read_sheet(args.sheet)
    tasks = load_tasks(Path(args.jsonl))
    print(json.dumps(compare(tasks, sheet), ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
