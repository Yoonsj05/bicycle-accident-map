
/*
  BIKE SAFE - 서울 자전거 사고 지도

  새 기능:
  - 서울 전체 사고 현황에서 연도 선택
  - 전체 / 2021 / 2022 / 2023
  - 연도에 따라 통계와 지도 마커 변경
  - 연도별 서울 전체 백분위 위험도
  - 기존 자치구 필터 유지

  기존 기능:
  - 공통 data.js 캐시 사용
  - 서울 전체 현황 기본 표시
  - 사고지역 상세정보
  - 패널 열기/닫기
  - 서울 전체 현황 복귀 버튼
  - 위험도별 색상
*/

// ========================================
// 1. 공통 변수
// ========================================

let map = null;
let risk = null;
let snapshot = null;

let groups = [];
let reference = null;
let partial = true;

let selectedYear = "all";
let selectedKey = null;
let panelMode = "overview";

let fitOnce = false;
let renderTimer = null;

const overlays = new Map();

const $ = id => document.getElementById(id);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmt(value) {
  return num(value).toLocaleString("ko-KR");
}

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

function setText(id, value) {
  const element = $(id);

  if (element) {
    element.textContent = value;
  }
}

function districtName(code) {
  if (code === "all") return "서울 전체";

  const select = $("district");

  const option = Array.from(select.options)
    .find(item => item.value === code);

  return option ? option.textContent : code;
}

function yearLabel() {
  if (selectedYear === "all") {
    return "21~23년";;
  }

  return selectedYear + "년";
}

// ========================================
// 2. 데이터 선택
// ========================================

function filteredYearItems() {
  if (!snapshot) return [];

  if (selectedYear === "all") {
    return snapshot.items;
  }

  return snapshot.items.filter(
    item => String(item.year) === selectedYear
  );
}

function visibleGroups() {
  const district = $("district").value;

  if (district === "all") {
    return groups;
  }

  return groups.filter(
    item => item.districtCode === district
  );
}

// ========================================
// 3. 패널 열기/닫기
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

  if ($("detailPanel")) {
    $("detailPanel").scrollTop = 0;
  }
}

window.closeDetailPanel = closeDetailPanel;
window.showSeoulOverview = showSeoulOverview;

// ========================================
// 4. 통계 카드
// ========================================

function createOverviewCard(label, value) {
  const card = makeElement(
    "div",
    "overview-card"
  );

  card.append(
    makeElement(
      "span",
      "overview-label",
      label
    ),
    makeElement(
      "strong",
      "overview-number",
      value
    )
  );

  return card;
}

function createDetailRow(label, value) {
  const row = makeElement(
    "div",
    "detail-row"
  );

  row.append(
    makeElement("span", "detail-label", label),
    makeElement("span", "detail-value", value)
  );

  return row;
}

// ========================================
// 5. 연도 선택 UI 만들기
// ========================================

function createYearSelector() {
  const container = makeElement(
    "div",
    "bike-year-selector"
  );

  // 기존 CSS와 어울리는 스타일
  container.style.marginBottom = "18px";

  const label = makeElement(
    "label",
    "",
    "분석 연도 선택"
  );

  label.htmlFor = "bikeOverviewYear";

  label.style.display = "block";
  label.style.marginBottom = "9px";
  label.style.fontSize = "12px";
  label.style.fontWeight = "800";
  label.style.color = "#193e65";

  const select = document.createElement("select");

  select.id = "bikeOverviewYear";

  select.style.width = "100%";
  select.style.height = "42px";
  select.style.padding = "0 12px";
  select.style.border = "1px solid #cfdeeb";
  select.style.borderRadius = "9px";
  select.style.background = "#ffffff";
  select.style.color = "#193e65";
  select.style.cursor = "pointer";

  const years = [
    ["all", "전체 (2021~2023년)"],
    ["2021", "2021년"],
    ["2022", "2022년"],
    ["2023", "2023년"]
  ];

  years.forEach(([value, text]) => {
    const option = document.createElement("option");

    option.value = value;
    option.textContent = text;

    select.appendChild(option);
  });

  select.value = selectedYear;

  select.addEventListener("change", event => {
    selectedYear = event.target.value;

    // 연도가 바뀌면 기존 마커와 상세정보 갱신
    selectedKey = null;
    panelMode = "overview";

    // 선택한 연도의 데이터로 지도와 통계 갱신
    renderAll(true);
  });

  container.append(label, select);

  return container;
}

// ========================================
// 6. 위험도 기준 계산
// ========================================

function updateRiskReference() {
  if (!groups.length) {
    reference = null;
    partial = true;
    return;
  }

  const calculated =
    risk.createRiskReference(groups);

  if (selectedYear !== "all") {
    // 해당 연도의 서울 전체 사고지역 기준
    reference = calculated;

    // 요청이 모두 완료됐더라도
    // 빠진 자료가 있을 수 있으므로 구분
    const missing = snapshot.failed.some(
      job => job.year === selectedYear
    );

    const pending = snapshot.total -
      snapshot.completed;

    partial = missing || pending > 0;

    // 연도별 기준은 기존 3개년 캐시를 덮어쓰지 않음
    return;
  }

  // 기존 3개년 공통 위험도 기준 유지
  const saved = risk.readRiskReference();

  const complete =
    snapshot.finished &&
    snapshot.failed.length === 0 &&
    snapshot.nodata.length === 0;

  if (complete && calculated) {
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

// ========================================
// 7. 위험도 범례 갱신
// ========================================

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

  legend.querySelectorAll(
    ".legend-segment"
  ).forEach((segment, index) => {
    const span = segment.querySelector("span");

    if (span) {
      span.textContent = labels[index];
    }
  });

  const caption = legend.querySelector(
    ".legend-heading span"
  );

  if (caption) {
    caption.textContent =
      (selectedYear === "all"
        ? "서울 전체 3개년"
        : selectedYear + "년 서울 전체") +
      (partial ? " · 임시 기준" : " · 백분위 기준");
  }
}

// ========================================
// 8. 서울 전체 자전거 사고 현황
// ========================================

function renderOverview() {
  if (panelMode !== "overview") return;

  setText(
    "detailTitle",
    "서울 전체 자전거 사고 현황"
  );

  const target = $("detailContent");
  const panel = $("detailPanel");

  if (!target || !snapshot) return;

  const oldScroll = panel.scrollTop;

  target.replaceChildren();

  target.appendChild(
    makeElement(
      "p",
      "overview-lead",
      "서울특별시 자전거 교통사고 " +
      "다발지역 공공데이터를 바탕으로 " +
      "사고지역과 인명피해 현황을 분석합니다. " +
      "연도를 선택하면 해당 연도의 결과를 " +
      "지도에서도 확인할 수 있습니다."
    )
  );

  // 새 연도 선택 기능
  target.appendChild(createYearSelector());

  const sum = field =>
    groups.reduce(
      (total, item) => total + num(item[field]),
      0
    );

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
      yearLabel()
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

    const count = groups.filter(
      item =>
        risk.getRiskLevel(
          item.riskScore,
          reference
        ) === level
    ).length;

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

  const progressText = snapshot.finished
    ? (
      `조회 완료 ${snapshot.completed}/${snapshot.total}건` +
      ` · 자료 없음 ${snapshot.nodata.length}건` +
      ` · 요청 실패 ${snapshot.failed.length}건`
    )
    : (
      `데이터 조회 중 ${snapshot.completed}/${snapshot.total}건` +
      " · 저장된 자료부터 표시 중"
    );

  target.appendChild(
    makeElement(
      "p",
      "overview-progress",
      progressText
    )
  );

  target.appendChild(
    makeElement(
      "p",
      "year-note",
      (
        selectedYear === "all"
          ? "2021~2023년 통합 사고지역 기준"
          : selectedYear + "년 사고지역 기준"
      ) +
      "으로 위험도를 비교합니다. " +
      (partial ? "일부 자료가 조회 중이거나 누락될 수 있습니다. " : "") +
      "위험등급은 BIKE SAFE의 자체 상대적 분류입니다."
    )
  );

  panel.scrollTop = oldScroll;
}

// ========================================
// 9. 사고지역 상세정보
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

  const target = $("detailContent");
  const panel = $("detailPanel");

  const oldScroll = panel.scrollTop;

  target.replaceChildren();

  const backButton = makeElement(
    "button",
    "detail-back-button",
    "← 서울 전체 자전거 사고 현황"
  );

  backButton.type = "button";
  backButton.addEventListener(
    "click",
    showSeoulOverview
  );

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
    ["부상신고자 수", "reportedInjuryCount", "명"]
  ];

  for (const [label, field, unit] of fields) {
    target.appendChild(
      createDetailRow(
        label,
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

    const fallback = pending
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
      : [year, fallback, "-"];

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
      "선택 기간: " + yearLabel() +
      " · 서울 전체 사고지역의 점수 분포를 " +
      "기준으로 비교한 자체 위험등급입니다."
    )
  );

  target.appendChild(
    makeElement(
      "p",
      "year-note",
      "기록 없음은 실제 사고가 0건이라는 " +
      "의미가 아니라, 해당 연도에 이 장소의 " +
      "사고다발지역 기록이 조회되지 않았다는 뜻입니다."
    )
  );

  openPanel();

  panel.scrollTop = resetScroll ? 0 : oldScroll;
}

// ========================================
// 10. 지도 마커
// ========================================

function createMarker(item) {
  const position = new kakao.maps.LatLng(
    Number(item.latitude),
    Number(item.longitude)
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

  const markerState = {
    item,
    level,
    score: item.riskScore,
    latitude: Number(item.latitude),
    longitude: Number(item.longitude),
    overlay: null,
    button
  };

  button.title =
    `${item.name} · 자전거 사고 위험도 ` +
    `${fmt(item.riskScore)}점`;

  button.setAttribute(
    "aria-label",
    button.title
  );

  button.addEventListener("click", () => {
    // 최신 데이터 사용
    showAccidentDetail(markerState.item);

    requestAnimationFrame(() => {
      map.relayout();

      map.panTo(
        new kakao.maps.LatLng(
          markerState.latitude,
          markerState.longitude
        )
      );
    });
  });

  const overlay = new kakao.maps.CustomOverlay({
    position,
    content: button,
    yAnchor: 0.5,
    zIndex: 3
  });

  overlay.setMap(map);
  markerState.overlay = overlay;

  return markerState;
}

function renderMap(fitBounds = false) {
  if (!map) return;

  const visible = visibleGroups();
  const keys = new Set();

  const bounds = new kakao.maps.LatLngBounds();

  let validCount = 0;
  let firstPosition = null;

  for (const item of visible) {
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < 33 ||
      latitude > 39 ||
      longitude < 124 ||
      longitude > 132
    ) {
      continue;
    }

    keys.add(item.key);

    const position = new kakao.maps.LatLng(
      latitude,
      longitude
    );

    if (!firstPosition) {
      firstPosition = position;
    }

    bounds.extend(position);
    validCount++;

    const current = overlays.get(item.key);

    const level = risk.getRiskLevel(
      item.riskScore,
      reference
    );

    if (current) {
      // 데이터는 항상 최신 값으로 교체
      current.item = item;

      const moved =
        current.latitude !== latitude ||
        current.longitude !== longitude;

      if (moved) {
        current.latitude = latitude;
        current.longitude = longitude;

        current.overlay.setPosition(position);
      }

      current.score = item.riskScore;
      current.level = level;

      current.button.className =
        "risk-marker " + level;

      current.button.title =
        `${item.name} · 자전거 사고 위험도 ` +
        `${fmt(item.riskScore)}점`;

      current.button.setAttribute(
        "aria-label",
        current.button.title
      );

    } else {
      overlays.set(
        item.key,
        createMarker(item)
      );
    }
  }

  // 연도 또는 자치구 변경 시 불필요한 마커 제거
  for (const [key, marker] of overlays) {
    if (!keys.has(key)) {
      marker.overlay.setMap(null);
      overlays.delete(key);
    }
  }

  if (fitBounds && validCount > 0) {
    if (validCount === 1) {
      map.setCenter(firstPosition);
      map.setLevel(5);
    } else {
      map.setBounds(bounds, 50, 50, 70, 50);
    }
  }

  setText("spotCount", fmt(visible.length));

  setText(
    "accidentCount",
    fmt(visible.reduce(
      (sum, item) => sum + num(item.accidentCount),
      0
    ))
  );

  setText(
    "casualtyCount",
    fmt(visible.reduce(
      (sum, item) => sum + num(item.casualtyCount),
      0
    ))
  );

  setText(
    "currentRegion",
    districtName($("district").value)
  );
}

// ========================================
// 11. 자치구 필터
// ========================================

function applyFilter() {
  if (!map) return;

  if (panelMode === "detail") {
    showSeoulOverview();
  }

  renderMap(true);
}

function resetFilter() {
  $("district").value = "all";
  applyFilter();
}

window.applyFilter = applyFilter;
window.resetFilter = resetFilter;

// ========================================
// 12. 전체 화면 갱신
// ========================================

function renderAll(forceFit = false) {
  if (!snapshot || !risk || !map) return;

  // 선택한 연도에 맞는 사고 기록
  const items = filteredYearItems();

  // 선택한 연도의 서울 전체 데이터 병합
  groups = risk.groupRiskAccidents(items);

  updateRiskReference();
  updateLegend();

  const firstFit =
    !fitOnce && groups.length > 0;

  renderMap(forceFit || firstFit);

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
    } else {
      showSeoulOverview();
    }
  }

  const status = snapshot.finished
    ? (
      `${yearLabel()} 자전거 사고지역 조회 완료` +
      ` · 자료 없음 ${snapshot.nodata.length}건` +
      ` · 요청 실패 ${snapshot.failed.length}건`
    )
    : (
      `${yearLabel()} 자전거 사고지역 조회 중 ` +
      `${snapshot.completed}/${snapshot.total}건` +
      " · 저장된 데이터부터 표시"
    );

  setText("status", status);
}

// ========================================
// 13. 페이지 시작
// ========================================

window.addEventListener("load", async () => {
  if (
    !$("map") ||
    !$("mapLayout") ||
    !$("detailPanel") ||
    !$("detailContent") ||
    !$("district")
  ) {
    console.error(
      "BIKE SAFE 필수 지도 요소가 없습니다."
    );

    return;
  }

  if (!window.kakao?.maps) {
    setText(
      "detailContent",
      "카카오맵 SDK를 불러오지 못했습니다."
    );

    return;
  }

  try {
    risk = await import("./risk.js");

    const shared = await import("./data.js");

    map = new kakao.maps.Map($("map"), {
      center: new kakao.maps.LatLng(
        37.5665,
        126.9780
      ),
      level: 9
    });

    reference = risk.readRiskReference();

    snapshot = shared.getSnapshot();

    // 기존과 동일하게 서울 전체 패널 기본 표시
    panelMode = "overview";

    $("mapLayout").classList.add("active");

    const openButton =
      $("openOverviewButton");

    if (openButton) {
      openButton.hidden = true;
    }

    resizeMap();
    renderAll();

    // 캐시 및 새 API 데이터 자동 갱신
    shared.subscribe(next => {
      snapshot = next;

      if (renderTimer) {
        clearTimeout(renderTimer);
      }

      if (next.finished || !next.loading) {
        renderAll();
      } else {
        renderTimer = setTimeout(
          () => renderAll(),
          180
        );
      }
    });

    shared.startLoading();

  } catch (error) {
    console.error(error);

    setText(
      "detailContent",
      "자전거 사고 데이터를 불러오지 못했습니다."
    );
  }
});
