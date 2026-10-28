
/*
  BIKE SAFE - 사고 지도

  기존 기능과 디자인 유지
  - 서울 전체 사고 현황
  - 2021~2023년 연도 선택
  - 25개 자치구 필터
  - 사고지역 상세정보
  - 위험도 색상 표시
  - 지도 패널 열기/닫기
  - 공통 데이터 캐시 활용

  최적화
  - 선택한 연도의 조회 상태만 검사
  - 최신 데이터로 마커 재사용
  - 불필요한 화면 갱신 감소
  - 자료 없음과 요청 실패 구분
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
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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
  if (code === "all") {
    return "서울 전체";
  }

  const select = $("district");

  const option = Array.from(select.options)
    .find(item => item.value === code);

  return option ? option.textContent : code;
}

function yearLabel() {
  if (selectedYear === "all") {
    return "21~23년";
  }

  return selectedYear + "년";
}

// ========================================
// 2. 연도별 데이터 상태
// ========================================

function matchingYear(job) {
  return (
    selectedYear === "all" ||
    String(job.year) === selectedYear
  );
}

function yearProgress() {
  if (!snapshot) {
    return {
      total: 0,
      completed: 0,
      nodata: 0,
      failed: 0,
      pending: 0,
      finished: false
    };
  }

  const success = snapshot.success.filter(
    matchingYear
  ).length;

  const nodata = snapshot.nodata.filter(
    matchingYear
  ).length;

  const failed = snapshot.failed.filter(
    matchingYear
  ).length;

  const total =
    selectedYear === "all"
      ? snapshot.total
      : risk.RISK_DISTRICTS.length;

  const completed = success + nodata + failed;

  return {
    total,
    completed,
    nodata,
    failed,
    pending: Math.max(0, total - completed),
    finished: completed >= total
  };
}

function filteredYearItems() {
  if (!snapshot) {
    return [];
  }

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
    item => String(item.districtCode) === district
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

  $("detailPanel").scrollTop = 0;
}

window.closeDetailPanel = closeDetailPanel;
window.showSeoulOverview = showSeoulOverview;

// ========================================
// 4. 공통 화면 요소
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
// 5. 분석 연도 선택
// ========================================

function createYearSelector() {
  const container = makeElement(
    "div",
    "bike-year-selector"
  );

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

  // 기존 연도 선택 문구 유지
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

    selectedKey = null;
    panelMode = "overview";

    renderAll(true);
  });

  container.append(label, select);

  return container;
}

// ========================================
// 6. 위험도 기준
// ========================================

function updateRiskReference() {
  if (!groups.length) {
    reference = null;
    partial = true;
    return;
  }

  const calculated =
    risk.createRiskReference(groups);

  const progress = yearProgress();

  if (selectedYear !== "all") {
    // 선택한 연도의 서울 전체 기준
    reference = calculated;

    partial =
      progress.pending > 0 ||
      progress.failed > 0 ||
      progress.nodata > 0;

    return;
  }

  // 3개년 통합 기준
  const saved = risk.readRiskReference();

  const complete =
    progress.finished &&
    progress.failed === 0 &&
    progress.nodata === 0;

  if (complete && calculated) {
    reference = calculated;
    partial = false;

    if (
      !saved ||
      saved.p50 !== calculated.p50 ||
      saved.p80 !== calculated.p80 ||
      saved.spotCount !== calculated.spotCount
    ) {
      risk.saveRiskReference(calculated);
    }

    return;
  }

  // 자료가 일부 누락된 상황에서는
  // 완전한 기준인 것처럼 저장하지 않음
  reference = calculated || saved;

  partial = true;
}

// ========================================
// 7. 지도 위험도 범례
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

    if (span && labels[index]) {
      span.textContent = labels[index];
    }
  });

  const caption = legend.querySelector(
    ".legend-heading span"
  );

  if (caption) {
    const period =
      selectedYear === "all"
        ? "서울 전체 3개년"
        : selectedYear + "년 서울 전체";

    caption.textContent =
      period +
      (
        partial
          ? " · 조회된 자료 기준"
          : " · 백분위 기준"
      );
  }
}

// ========================================
// 8. 서울 전체 사고 현황
// ========================================

function renderOverview() {
  if (panelMode !== "overview") {
    return;
  }

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

  target.appendChild(
    createYearSelector()
  );

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

  const progress = yearProgress();

  const progressText = progress.finished
    ? (
      `조회 완료 ${progress.completed}/${progress.total}건` +
      ` · 자료 없음 ${progress.nodata}건` +
      ` · 요청 실패 ${progress.failed}건`
    )
    : (
      `데이터 조회 중 ${progress.completed}/${progress.total}건` +
      " · 저장된 자료부터 표시 중"
    );

  target.appendChild(
    makeElement(
      "p",
      "overview-progress",
      progressText
    )
  );

  const note =
    (
      selectedYear === "all"
        ? "2021~2023년 통합 사고지역 기준"
        : selectedYear + "년 사고지역 기준"
    ) +
    "으로 위험도를 비교합니다. " +
    (
      partial
        ? "일부 자료가 조회 중이거나 누락될 수 있습니다. "
        : ""
    ) +
    "위험등급은 BIKE SAFE의 자체 상대적 분류입니다.";

  target.appendChild(
    makeElement(
      "p",
      "year-note",
      note
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
      String(job.year) === String(year) &&
      String(job.district) === String(item.districtCode);

    const succeeded = snapshot.success.some(matches);
    const noData = snapshot.nodata.some(matches);
    const failed = snapshot.failed.some(matches);

    const outsidePeriod =
      selectedYear !== "all" &&
      String(year) !== selectedYear;

    let values;

    if (outsidePeriod) {
      values = [year, "선택 기간 외", "-"];
    } else if (record) {
      values = [
        year,
        fmt(record.accidentCount) + "건",
        fmt(record.casualtyCount) + "명"
      ];
    } else if (failed) {
      values = [year, "조회 실패", "-"];
    } else if (noData) {
      values = [year, "자료 없음", "-"];
    } else if (succeeded) {
      values = [year, "기록 없음", "-"];
    } else {
      values = [year, "조회 중", "-"];
    }

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
      "의미가 아니라 해당 연도의 사고다발지역 " +
      "기록이 조회되지 않았다는 뜻입니다."
    )
  );

  openPanel();

  panel.scrollTop =
    resetScroll ? 0 : oldScroll;
}

// ========================================
// 10. 지도 마커 생성
// ========================================

function createMarker(item) {
  const latitude = Number(item.latitude);
  const longitude = Number(item.longitude);

  const position = new kakao.maps.LatLng(
    latitude,
    longitude
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
    latitude,
    longitude,
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

  // 클릭할 때 현재 저장된 최신 데이터 사용
  button.addEventListener("click", () => {
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

// ========================================
// 11. 지도 마커 갱신
// ========================================

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

    const level = risk.getRiskLevel(
      item.riskScore,
      reference
    );

    const current = overlays.get(item.key);

    if (!current) {
      overlays.set(
        item.key,
        createMarker(item)
      );

      continue;
    }

    // 기존 마커를 제거하지 않고 재사용
    current.item = item;

    if (
      current.latitude !== latitude ||
      current.longitude !== longitude
    ) {
      current.latitude = latitude;
      current.longitude = longitude;

      current.overlay.setPosition(position);
    }

    const className = "risk-marker " + level;

    if (current.button.className !== className) {
      current.button.className = className;
    }

    const title =
      `${item.name} · 자전거 사고 위험도 ` +
      `${fmt(item.riskScore)}점`;

    if (current.button.title !== title) {
      current.button.title = title;
      current.button.setAttribute(
        "aria-label",
        title
      );
    }
  }

  // 현재 선택한 연도/지역에 없는 마커 제거
  for (const [key, marker] of overlays) {
    if (!keys.has(key)) {
      marker.overlay.setMap(null);
      overlays.delete(key);
    }
  }

  // 선택 변경 시 지도 범위 조정
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
          sum + num(item.accidentCount),
        0
      )
    )
  );

  setText(
    "casualtyCount",
    fmt(
      visible.reduce(
        (sum, item) =>
          sum + num(item.casualtyCount),
        0
      )
    )
  );

  setText(
    "currentRegion",
    districtName($("district").value)
  );
}

// ========================================
// 12. 자치구 선택
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
// 13. 화면 전체 갱신
// ========================================

function renderAll(forceFit = false) {
  if (!snapshot || !risk || !map) {
    return;
  }

  const items = filteredYearItems();

  // 선택 연도에 해당하는 서울 전체 사고지역
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

  const progress = yearProgress();

  const status = progress.finished
    ? (
      `${yearLabel()} 자전거 사고지역 조회 완료` +
      ` · 자료 없음 ${progress.nodata}건` +
      ` · 요청 실패 ${progress.failed}건`
    )
    : (
      `${yearLabel()} 자전거 사고지역 조회 중 ` +
      `${progress.completed}/${progress.total}건` +
      " · 저장된 데이터부터 표시"
    );

  setText("status", status);
}

// ========================================
// 14. 데이터 갱신 예약
// ========================================

function scheduleRender(next) {
  snapshot = next;

  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }

  // 조회 완료 시 즉시 화면 갱신
  if (next.finished || !next.loading) {
    renderAll();
    return;
  }

  // API 응답이 연속될 때 갱신 횟수 줄이기
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderAll();
  }, 180);
}

// ========================================
// 15. 페이지 초기화
// ========================================

window.addEventListener("load", async () => {
  const required = [
    "map",
    "mapLayout",
    "detailPanel",
    "detailContent",
    "district"
  ];

  const missing = required.filter(
    id => !$(id)
  );

  if (missing.length > 0) {
    console.error(
      "BIKE SAFE 필수 요소 누락:",
      missing
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

    map = new kakao.maps.Map(
      $("map"),
      {
        center: new kakao.maps.LatLng(
          37.5665,
          126.9780
        ),
        level: 9
      }
    );

    reference = risk.readRiskReference();

    snapshot = shared.getSnapshot();

    // 기존처럼 첫 화면은 전체 현황 표시
    panelMode = "overview";

    $("mapLayout").classList.add("active");

    const button = $("openOverviewButton");

    if (button) {
      button.hidden = true;
    }

    resizeMap();
    renderAll();

    // 공통 데이터 관리자의 변경 사항 구독
    shared.subscribe(scheduleRender);

    // 저장된 데이터 먼저 불러온 뒤
    // 부족한 공공데이터 조회
    shared.startLoading();

  } catch (error) {
    console.error(
      "BIKE SAFE 지도 초기화 오류:",
      error
    );

    const target = $("detailContent");

    if (target) {
      target.textContent =
        "자전거 사고 데이터를 불러오지 못했습니다.";
    }
  }
});
