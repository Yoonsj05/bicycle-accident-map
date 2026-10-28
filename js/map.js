
/*
  BIKE SAFE - 서울 자전거 사고 지도

  이번 수정:
  - 지역 선택 시 왼쪽 현황도 해당 자치구로 변경
  - 지역별 사고 건수, 사상자 수, 사망자 수 표시
  - 자료 없음 / 조회 중 / 조회 실패 구분

  기존 유지:
  - 분석 기간 21~23년
  - 연도 메뉴 전체 (2021~2023년)
  - 지도 마커, 위험도 색상
  - 서울 전체 위험도 비교 기준
  - 상세정보 및 패널 열기/닫기
  - 기존 HTML / CSS
*/

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
  if (element) element.textContent = value;
}

function selectedDistrict() {
  return $("district")?.value || "all";
}

function districtName(code = selectedDistrict()) {
  if (code === "all") return "서울 전체";

  const option = Array.from(
    $("district")?.options || []
  ).find(item => item.value === code);

  return option
    ? option.textContent.trim()
    : code;
}

function yearLabel() {
  if (selectedYear === "all") {
    return "21~23년";
  }

  return selectedYear + "년";
}

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
  const district = selectedDistrict();

  if (district === "all") {
    return groups;
  }

  return groups.filter(
    item => String(item.districtCode) === district
  );
}

// ========================================
// 선택한 연도 + 자치구 조회 상태
// ========================================

function getProgress(district = selectedDistrict()) {
  if (!snapshot || !risk) {
    return {
      total: 0,
      completed: 0,
      nodata: 0,
      failed: 0,
      pending: 0,
      finished: false
    };
  }

  const matches = job => {
    const yearMatches =
      selectedYear === "all" ||
      String(job.year) === selectedYear;

    const districtMatches =
      district === "all" ||
      String(job.district) === String(district);

    return yearMatches && districtMatches;
  };

  const success = snapshot.success.filter(
    matches
  ).length;

  const nodata = snapshot.nodata.filter(
    matches
  ).length;

  const failed = snapshot.failed.filter(
    matches
  ).length;

  const yearCount =
    selectedYear === "all"
      ? risk.RISK_YEARS.length
      : 1;

  const districtCount =
    district === "all"
      ? risk.RISK_DISTRICTS.length
      : 1;

  const total = yearCount * districtCount;

  const completed = success + nodata + failed;

  return {
    total,
    completed,
    success,
    nodata,
    failed,
    pending: Math.max(0, total - completed),
    finished: completed >= total
  };
}

// ========================================
// 패널 열기 / 닫기
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
  // 함수 이름은 기존 HTML과의 연결을 위해 유지.
  // 실제 화면은 현재 선택한 자치구 현황을 표시.
  panelMode = "overview";
  selectedKey = null;

  renderOverview();
  openPanel();

  $("detailPanel").scrollTop = 0;
}

window.closeDetailPanel = closeDetailPanel;
window.showSeoulOverview = showSeoulOverview;

// ========================================
// 통계 화면 구성 요소
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
    makeElement(
      "span",
      "detail-label",
      label
    ),
    makeElement(
      "span",
      "detail-value",
      value
    )
  );

  return row;
}

// ========================================
// 연도 선택
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

  // 기존 메뉴 문구 변경하지 않음
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
// 서울 전체 위험도 기준
// ========================================

function updateRiskReference() {
  if (!groups.length) {
    reference = null;
    partial = true;
    return;
  }

  // 자치구 선택과 관계없이 서울 전체 데이터 기준
  const calculated = risk.createRiskReference(groups);

  const progress = getProgress("all");

  if (selectedYear !== "all") {
    reference = calculated;

    partial =
      progress.pending > 0 ||
      progress.failed > 0 ||
      progress.nodata > 0;

    return;
  }

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

  reference = calculated || saved;
  partial = true;
}

// ========================================
// 위험도 범례
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
// 자료 없음 / 조회 중 안내
// ========================================

function renderEmptyState(target, progress) {
  const area = districtName();

  const box = makeElement(
    "div",
    "overview-card"
  );

  box.style.padding = "22px 16px";
  box.style.textAlign = "center";

  let heading = "";
  let description = "";

  if (progress.pending > 0) {
    heading = "사고 데이터를 조회하고 있습니다.";

    description =
      `${area}의 ${yearLabel()} 자료를 ` +
      "확인하고 있어요.";
  } else if (progress.failed > 0) {
    heading = "사고 데이터를 불러오지 못했습니다.";

    description =
      "공공데이터 API 요청에 실패했습니다. " +
      "잠시 후 다시 접속해 주세요.";
  } else if (progress.nodata > 0) {
    heading = "조회된 사고다발지역 자료가 없습니다.";

    description =
      `${area}의 선택 기간에 해당하는 ` +
      "사고다발지역 자료가 제공되지 않았습니다. " +
      "실제 사고가 0건이라는 의미는 아닙니다.";
  } else {
    heading = "조회된 사고지역이 없습니다.";

    description =
      `${area}의 선택 기간에 해당하는 ` +
      "사고다발지역 기록이 확인되지 않았습니다.";
  }

  const title = makeElement(
    "strong",
    "",
    heading
  );

  title.style.display = "block";
  title.style.marginBottom = "10px";

  const text = makeElement(
    "p",
    "",
    description
  );

  text.style.fontSize = "13px";
  text.style.lineHeight = "1.7";
  text.style.color = "#52697d";

  box.append(title, text);

  target.appendChild(box);
}

// ========================================
// 왼쪽 사고 현황 패널
// ========================================

function renderOverview() {
  if (panelMode !== "overview") return;

  const area = districtName();

  setText(
    "detailTitle",
    area + " 자전거 사고 현황"
  );

  const target = $("detailContent");
  const panel = $("detailPanel");

  if (!target || !snapshot) return;

  const oldScroll = panel.scrollTop;

  target.replaceChildren();

  // 선택한 자치구 데이터만 통계에 사용
  const displayed = visibleGroups();
  const progress = getProgress();

  const description =
    selectedDistrict() === "all"
      ? (
        "서울특별시 자전거 교통사고 " +
        "다발지역 공공데이터를 바탕으로 " +
        "사고지역과 인명피해 현황을 분석합니다. " +
        "연도를 선택하면 해당 연도의 결과를 " +
        "지도에서도 확인할 수 있습니다."
      )
      : (
        `${area}의 자전거 교통사고 ` +
        "다발지역 공공데이터를 분석합니다. " +
        "연도를 변경하면 선택한 지역의 " +
        "해당 연도 현황을 확인할 수 있습니다."
      );

  target.appendChild(
    makeElement(
      "p",
      "overview-lead",
      description
    )
  );

  // 연도 선택 기능은 그대로 유지
  target.appendChild(createYearSelector());

  // 자료 없음 / 조회 중 / 오류 안내
  if (displayed.length === 0) {
    renderEmptyState(target, progress);
  } else {
    const sum = field =>
      displayed.reduce(
        (total, item) => total + num(item[field]),
        0
      );

    target.appendChild(
      createOverviewCard(
        "자전거 교통사고 다발지역",
        fmt(displayed.length) + "곳"
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

      const count = displayed.filter(
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
  }

  // 조회 결과 상태
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
      (
        partial ||
        progress.pending > 0 ||
        progress.failed > 0 ||
        progress.nodata > 0
          ? "일부 자료가 조회 중이거나 누락될 수 있습니다. "
          : ""
      ) +
      "위험등급은 서울 전체 데이터를 기준으로 한 " +
      "BIKE SAFE의 자체 상대적 분류입니다."
    )
  );

  panel.scrollTop = oldScroll;
}

// ========================================
// 개별 사고지역 상세정보
// ========================================

function showAccidentDetail(item, resetScroll = true) {
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
    "← " + districtName() + " 자전거 사고 현황"
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
      String(job.district) ===
        String(item.districtCode);

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
// 지도 마커
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
      overlays.set(item.key, createMarker(item));
      continue;
    }

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
      map.setBounds(
        bounds,
        50,
        50,
        70,
        50
      );
    }
  }

  setText("spotCount", fmt(visible.length));

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
    districtName()
  );
}

// ========================================
// 자치구 변경
// ========================================

function applyFilter() {
  if (!map || !snapshot) return;

  // 핵심 수정:
  // 지역을 바꾸면 왼쪽 현황도 새 지역으로 변경
  selectedKey = null;

  if (panelMode !== "closed") {
    panelMode = "overview";
  }

  renderAll(true);

  if (panelMode === "overview") {
    $("detailPanel").scrollTop = 0;
  }
}

function resetFilter() {
  $("district").value = "all";
  applyFilter();
}

window.applyFilter = applyFilter;
window.resetFilter = resetFilter;

// ========================================
// 전체 화면 갱신
// ========================================

function renderAll(forceFit = false) {
  if (!snapshot || !risk || !map) return;

  const items = filteredYearItems();

  // 서울 전체 그룹을 먼저 계산:
  // 자치구를 바꿔도 위험도 기준이 흔들리지 않음
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

    if (
      item &&
      (
        selectedDistrict() === "all" ||
        String(item.districtCode) ===
          selectedDistrict()
      )
    ) {
      showAccidentDetail(item, false);
    } else {
      showSeoulOverview();
    }
  }

  const progress = getProgress();
  const area = districtName();

  const status = progress.finished
    ? (
      `${area} · ${yearLabel()} 조회 완료` +
      ` · 자료 없음 ${progress.nodata}건` +
      ` · 요청 실패 ${progress.failed}건`
    )
    : (
      `${area} · ${yearLabel()} 조회 중 ` +
      `${progress.completed}/${progress.total}건` +
      " · 저장된 자료부터 표시"
    );

  setText("status", status);
}

// ========================================
// 데이터 변경 시 화면 갱신
// ========================================

function scheduleRender(next) {
  snapshot = next;

  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }

  if (next.finished || !next.loading) {
    renderAll();
    return;
  }

  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderAll();
  }, 180);
}

// ========================================
// 지도 시작
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

    panelMode = "overview";

    $("mapLayout").classList.add("active");

    const button = $("openOverviewButton");

    if (button) {
      button.hidden = true;
    }

    resizeMap();
    renderAll();

    shared.subscribe(scheduleRender);
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
