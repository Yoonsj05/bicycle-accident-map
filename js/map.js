
/*
  BIKE SAFE 사고 지도

  기존 HTML/CSS 디자인 유지
  공통 데이터 관리자(data.js) 사용

  기능:
  - 서울 전체 자전거 사고 현황
  - 개별 사고지역 상세정보
  - 패널 열기/닫기
  - 자치구 필터
  - 위험도별 마커
  - 저장된 데이터 즉시 표시
*/

// ========================================
// 1. 상태와 기본 함수
// ========================================

let map;
let risk;
let snapshot;

let groups = [];
let reference = null;
let partial = true;

let selectedKey = null;
let panelMode = "overview";

let fitOnce = false;
let renderTimer = null;

const overlays = new Map();

const $ = id => document.getElementById(id);

const numeric = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const fmt = value =>
  numeric(value).toLocaleString("ko-KR");

function makeElement(tag, className = "", text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = String(text);
  }

  return element;
}

const panel = () => $("detailPanel");
const content = () => $("detailContent");
const districtSelect = () => $("district");

function setText(id, value) {
  const element = $(id);

  if (element) {
    element.textContent = value;
  }
}

function districtName(code) {
  const option = Array.from(
    districtSelect().options
  ).find(item => item.value === code);

  return option ? option.textContent : code;
}

// ========================================
// 2. 패널 열기/닫기
// ========================================

function resizeMap() {
  if (!map) return;

  requestAnimationFrame(() => {
    map.relayout();
  });
}

function openPanel() {
  $("mapLayout").classList.add("active");

  const button = $("openOverviewButton");

  if (button) {
    button.hidden = true;
  }

  resizeMap();
}

function closeDetailPanel() {
  panelMode = "closed";
  selectedKey = null;

  $("mapLayout").classList.remove("active");

  const button = $("openOverviewButton");

  if (button) {
    button.hidden = false;
  }

  resizeMap();
}

function showSeoulOverview() {
  panelMode = "overview";
  selectedKey = null;

  renderOverview();
  openPanel();

  if (panel()) {
    panel().scrollTop = 0;
  }
}

window.closeDetailPanel = closeDetailPanel;
window.showSeoulOverview = showSeoulOverview;

// ========================================
// 3. 화면 요소 생성
// ========================================

function createDetailRow(label, value) {
  const row = makeElement("div", "detail-row");

  row.append(
    makeElement("span", "detail-label", label),
    makeElement("span", "detail-value", value)
  );

  return row;
}

function createOverviewCard(label, value) {
  const card = makeElement("div", "overview-card");

  card.append(
    makeElement("span", "overview-label", label),
    makeElement("strong", "overview-number", value)
  );

  return card;
}

// ========================================
// 4. 위험도 기준
// ========================================

function updateRiskReference() {
  const calculated = groups.length
    ? risk.createRiskReference(groups)
    : null;

  const saved = risk.readRiskReference();

  // 모든 요청이 성공한 경우에만
  // 새로운 서울 전체 기준 저장
  const fullyKnown =
    snapshot.finished &&
    snapshot.failed.length === 0 &&
    snapshot.nodata.length === 0;

  if (fullyKnown && calculated) {
    reference = calculated;
    partial = false;

    if (
      !saved ||
      saved.p50 !== calculated.p50 ||
      saved.p80 !== calculated.p80
    ) {
      risk.saveRiskReference(calculated);
    }

  } else {
    reference = saved || calculated;
    partial = !saved;
  }
}

function updateLegend() {
  const legend = document.querySelector(
    ".risk-legend-bar"
  );

  if (!legend || !risk) return;

  const ranges = risk.getRiskRanges(reference);

  const labels = [
    "주의 · " + ranges.low,
    "높음 · " + ranges.medium,
    "매우 높음 · " + ranges.high
  ];

  const segments = legend.querySelectorAll(
    ".legend-segment"
  );

  segments.forEach((segment, index) => {
    const label = segment.querySelector("span");

    if (label) {
      label.textContent = labels[index];
    }
  });

  const caption = legend.querySelector(
    ".legend-heading span"
  );

  if (caption) {
    caption.textContent = partial
      ? "조회된 자료 임시 기준"
      : "서울 전체 백분위 기준";
  }
}

// ========================================
// 5. 서울 전체 자전거 사고 현황
// ========================================

function renderOverview() {
  if (panelMode !== "overview") return;

  setText(
    "detailTitle",
    "서울 전체 자전거 사고 현황"
  );

  const target = content();

  if (!target || !snapshot) return;

  const scroll = panel().scrollTop;

  target.replaceChildren();

  target.appendChild(
    makeElement(
      "p",
      "overview-lead",
      "2021~2023년 서울 자전거 교통사고 " +
      "다발지역 공공데이터를 분석한 결과입니다. " +
      "조회된 지역의 사고 및 인명피해 현황을 " +
      "보여줍니다."
    )
  );

  const sum = field => {
    return groups.reduce(
      (total, item) =>
        total + numeric(item[field]),
      0
    );
  };

  target.appendChild(
    createOverviewCard(
      "자전거 교통사고 다발지역",
      fmt(groups.length) + "곳"
    )
  );

  const grid = makeElement(
    "div",
    "overview-grid"
  );

  grid.append(
    createOverviewCard(
      "자전거 사고 건수",
      fmt(sum("accidentCount")) + "건"
    ),
    createOverviewCard(
      "사상자 수",
      fmt(sum("casualtyCount")) + "명"
    ),
    createOverviewCard(
      "사망자 수",
      fmt(sum("deathCount")) + "명"
    ),
    createOverviewCard(
      "분석 기간",
      "3개년"
    )
  );

  target.appendChild(grid);

  target.appendChild(
    makeElement(
      "h3",
      "overview-section-title",
      "자전거 사고지역 위험도 분포"
    )
  );

  const levels = [
    ["low", "주의"],
    ["medium", "높음"],
    ["high", "매우 높음"]
  ];

  for (const [level, name] of levels) {
    const row = makeElement(
      "div",
      "overview-risk-row"
    );

    const label = makeElement(
      "span",
      "overview-risk-name"
    );

    label.append(
      makeElement(
        "span",
        "overview-dot " + level
      ),
      makeElement("span", "", name)
    );

    const count = groups.filter(item => {
      return risk.getRiskLevel(
        item.riskScore,
        reference
      ) === level;
    }).length;

    row.append(
      label,
      makeElement(
        "strong",
        "",
        fmt(count) + "곳"
      )
    );

    target.appendChild(row);
  }

  const progress = snapshot.finished
    ? (
      `조회 처리 완료 ` +
      `${snapshot.completed}/${snapshot.total}건\n` +
      `자료 없음 ${snapshot.nodata.length}건 · ` +
      `실제 실패 ${snapshot.failed.length}건`
    )
    : (
      `조회 진행 ` +
      `${snapshot.completed}/${snapshot.total}건\n` +
      "저장된 자료를 즉시 표시하고, " +
      "부족한 자료만 확인 중"
    );

  target.appendChild(
    makeElement(
      "p",
      "overview-progress",
      progress
    )
  );

  target.appendChild(
    makeElement(
      "p",
      "year-note",
      partial
        ? "현재 확보한 자료로 계산한 임시 상대 " +
          "위험도이며 공식 등급이 아닙니다."
        : "서울 전체 사고다발지역 점수 기준의 " +
          "자체 상대 위험도입니다."
    )
  );

  if (
    snapshot.nodata.length ||
    snapshot.failed.length
  ) {
    target.appendChild(
      makeElement(
        "p",
        "year-note",
        "자료 없음 또는 실패가 있는 " +
        "연도·자치구의 기록은 통계 합계에서 " +
        "빠져 있을 수 있습니다."
      )
    );
  }

  panel().scrollTop = scroll;
}

// ========================================
// 6. 사고지역 상세정보
// ========================================

function showAccidentDetail(
  item,
  resetScroll = true
) {
  panelMode = "detail";
  selectedKey = item.key;

  setText(
    "detailTitle",
    "자전거 사고지역 상세정보"
  );

  const target = content();
  const oldScroll = panel().scrollTop;

  target.replaceChildren();

  // 서울 전체 현황으로 복귀
  const backButton = makeElement(
    "button",
    "detail-back-button",
    "← 서울 전체 자전거 사고 현황"
  );

  backButton.type = "button";
  backButton.onclick = showSeoulOverview;

  target.append(
    backButton,
    makeElement(
      "h3",
      "region-name",
      item.name
    )
  );

  const fields = [
    ["자전거 사고 건수", "accidentCount", "건"],
    ["사상자 수", "casualtyCount", "명"],
    ["사망자 수", "deathCount", "명"],
    ["중상자 수", "seriousCount", "명"],
    ["경상자 수", "minorCount", "명"],
    [
      "부상신고자 수",
      "reportedInjuryCount",
      "명"
    ]
  ];

  for (const [name, field, unit] of fields) {
    target.appendChild(
      createDetailRow(
        name,
        fmt(item[field]) + unit
      )
    );
  }

  target.appendChild(
    makeElement(
      "h4",
      "year-heading",
      "연도별 자전거 사고 현황"
    )
  );

  // 연도별 사고 표
  const table = makeElement(
    "table",
    "year-table"
  );

  const thead = document.createElement("thead");
  const header = document.createElement("tr");

  ["연도", "사고", "사상자"].forEach(text => {
    header.appendChild(
      makeElement("th", "", text)
    );
  });

  thead.appendChild(header);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const year of risk.RISK_YEARS) {
    const record = item.records[year];

    const matches = job =>
      job.year === year &&
      job.district === item.districtCode;

    const pending =
      !snapshot.success.some(matches) &&
      !snapshot.nodata.some(matches) &&
      !snapshot.failed.some(matches);

    const status = pending
      ? "조회 중"
      : snapshot.failed.some(matches)
        ? "조회 실패"
        : snapshot.nodata.some(matches)
          ? "자료 없음"
          : "기록 없음";

    const values = record
      ? [
          year,
          fmt(record.accidentCount) + "건",
          fmt(record.casualtyCount) + "명"
        ]
      : [year, status, "-"];

    const tr = document.createElement("tr");

    values.forEach(value => {
      tr.appendChild(
        makeElement("td", "", value)
      );
    });

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  target.appendChild(table);

  // 위험도에 맞는 노랑/주황/빨강 카드
  const level = risk.getRiskLevel(
    item.riskScore,
    reference
  );

  const scoreBox = makeElement(
    "div",
    "score-box risk-" + level
  );

  scoreBox.append(
    makeElement(
      "div",
      "score-risk-label",
      risk.getRiskLabel(
        item.riskScore,
        reference
      ) + " · 자전거 사고 상대적 위험도"
    ),
    makeElement(
      "strong",
      "score-number",
      fmt(item.riskScore) + "점"
    )
  );

  target.appendChild(scoreBox);

  target.appendChild(
    makeElement(
      "p",
      "score-caption",
      partial
        ? "조회된 자료 기준 임시 상대 위험도 · " +
          "공식 위험등급 아님"
        : "서울 전체 자전거 사고다발지역 " +
          "비교 기준 · 공식 위험등급 아님"
    )
  );

  target.appendChild(
    makeElement(
      "p",
      "year-note",
      "기록 없음은 실제 사고 0건이 아니라 " +
      "해당 연도에 이 장소의 사고다발지역 " +
      "기록이 조회되지 않았음을 의미합니다."
    )
  );

  openPanel();

  panel().scrollTop = resetScroll
    ? 0
    : oldScroll;
}

// ========================================
// 7. 지도 마커
// ========================================

function visibleGroups() {
  const district = districtSelect().value;

  return district === "all"
    ? groups
    : groups.filter(
        item => item.districtCode === district
      );
}

function createMarker(item) {
  const position = new kakao.maps.LatLng(
    item.latitude,
    item.longitude
  );

  const level = risk.getRiskLevel(
    item.riskScore,
    reference
  );

  const button = makeElement(
    "button",
    "risk-marker " + level
  );

  button.type = "button";

  button.title =
    `${item.name} · ${fmt(item.riskScore)}점`;

  button.setAttribute(
    "aria-label",
    button.title
  );

  button.addEventListener("click", () => {
    showAccidentDetail(item);

    requestAnimationFrame(() => {
      map.relayout();
      map.panTo(position);
    });
  });

  const overlay = new kakao.maps.CustomOverlay({
    position,
    content: button,
    yAnchor: 0.5,
    zIndex: 3
  });

  overlay.setMap(map);

  return {
    overlay,
    button,
    level,
    score: item.riskScore
  };
}

function renderMap(fitBounds = false) {
  const visible = visibleGroups();

  const visibleKeys = new Set();

  const bounds = new kakao.maps.LatLngBounds();

  let validCount = 0;
  let firstPosition = null;

  for (const item of visible) {
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      continue;
    }

    const position = new kakao.maps.LatLng(
      latitude,
      longitude
    );

    if (!firstPosition) {
      firstPosition = position;
    }

    validCount++;
    visibleKeys.add(item.key);

    const current = overlays.get(item.key);

    const level = risk.getRiskLevel(
      item.riskScore,
      reference
    );

    if (current) {
      // 점수가 그대로면 기존 마커 재사용
      if (current.score !== item.riskScore) {
        current.overlay.setMap(null);

        overlays.set(
          item.key,
          createMarker(item)
        );

      } else {
        if (current.level !== level) {
          current.button.className =
            "risk-marker " + level;

          current.level = level;
        }

        current.button.title =
          `${item.name} · ${fmt(item.riskScore)}점`;
      }

    } else {
      overlays.set(
        item.key,
        createMarker(item)
      );
    }

    bounds.extend(position);
  }

  // 더 이상 보이지 않는 마커 제거
  for (const [key, marker] of overlays) {
    if (!visibleKeys.has(key)) {
      marker.overlay.setMap(null);
      overlays.delete(key);
    }
  }

  // 처음 접속하거나 지역을 직접 변경했을 때
  if (fitBounds && validCount > 0) {
    if (validCount === 1) {
      map.setCenter(firstPosition);
      map.setLevel(5);

    } else {
      map.setBounds(
        bounds,
        50,
        50,
        70,
        50
      );
    }
  }

  setText(
    "spotCount",
    fmt(visible.length)
  );

  setText(
    "accidentCount",
    fmt(
      visible.reduce(
        (sum, item) =>
          sum + numeric(item.accidentCount),
        0
      )
    )
  );

  setText(
    "casualtyCount",
    fmt(
      visible.reduce(
        (sum, item) =>
          sum + numeric(item.casualtyCount),
        0
      )
    )
  );

  setText(
    "currentRegion",
    districtName(districtSelect().value)
  );
}

// ========================================
// 8. 지역 선택
// ========================================

function applyFilter() {
  if (!map) return;

  if (panelMode === "detail") {
    showSeoulOverview();
  }

  renderMap(true);
}

function resetFilter() {
  districtSelect().value = "all";
  applyFilter();
}

window.applyFilter = applyFilter;
window.resetFilter = resetFilter;

// ========================================
// 9. 전체 화면 갱신
// ========================================

function renderAll() {
  if (!snapshot || !risk || !map) return;

  groups = risk.groupRiskAccidents(
    snapshot.items
  );

  updateRiskReference();
  updateLegend();

  const firstFit =
    !fitOnce && groups.length > 0;

  renderMap(firstFit);

  if (firstFit) {
    fitOnce = true;
  }

  if (panelMode === "overview") {
    renderOverview();

  } else if (panelMode === "detail") {
    const item = groups.find(
      group => group.key === selectedKey
    );

    if (item) {
      showAccidentDetail(item, false);
    }
  }

  const status = snapshot.finished
    ? (
      "자전거 사고지역 조회 완료 · " +
      `자료 없음 ${snapshot.nodata.length}건 · ` +
      `실제 실패 ${snapshot.failed.length}건`
    )
    : (
      "자전거 사고지역 조회 중 " +
      `${snapshot.completed}/${snapshot.total}건 · ` +
      "저장된 자료 우선 표시"
    );

  setText("status", status);
}

// ========================================
// 10. 페이지 시작
// ========================================

window.addEventListener("load", async () => {
  if (
    !$("map") ||
    !$("mapLayout") ||
    !$("detailPanel") ||
    !$("detailContent") ||
    !$("district")
  ) {
    return;
  }

  if (!window.kakao?.maps) {
    setText(
      "detailContent",
      "카카오맵 SDK를 불러오지 못했어요."
    );

    return;
  }

  try {
    risk = await import("./risk.js");

    const shared = await import("./data.js");

    map = new kakao.maps.Map($("map"), {
      center: new kakao.maps.LatLng(
        37.5665,
        126.978
      ),
      level: 9
    });

    reference = risk.readRiskReference();

    snapshot = shared.getSnapshot();

    // 첫 화면: 서울 전체 자전거 사고 현황
    renderOverview();
    resizeMap();

    // 캐시 데이터 또는 API 응답이 바뀔 때 갱신
    shared.subscribe(next => {
      snapshot = next;

      if (renderTimer) {
        clearTimeout(renderTimer);
      }

      if (next.finished || !next.loading) {
        renderAll();

      } else {
        renderTimer = setTimeout(
          renderAll,
          180
        );
      }
    });

    // 캐시를 먼저 읽고 부족한 자료만 요청
    shared.startLoading();

  } catch (error) {
    console.error(error);

    setText(
      "detailContent",
      "자전거 사고 데이터 파일을 " +
      "불러오지 못했어요."
    );
  }
});
