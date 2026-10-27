
/*
  BIKE SAFE - 서울 자전거 교통사고 위험지도

  개선 사항
  1. 서울 전체 자전거 사고 현황 기본 표시
  2. 개별 상세정보에서 서울 전체 현황으로 바로 복귀
  3. 위험도 점수에 따른 상세 카드 색상 적용
  4. 자전거 사고 관련 명칭 명확히 표시
  5. 조회 성공 자료부터 실시간 갱신
  6. NODATA_ERROR와 통신 실패 구분
  7. 패널 개폐 시 카카오맵 크기 재계산
*/

// =========================================
// 1. 설정
// =========================================

// 기존 Google Apps Script 배포 URL로 변경
const GAS_URL = 
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

const MAP_CENTER = {
  lat: 37.5665,
  lng: 126.9780
};

const REQUEST_TIMEOUT = 30000;
const MAX_RETRIES = 2;
const CACHE_DURATION = 60 * 60 * 1000;
const CONCURRENT_REQUESTS = 2;
const UPDATE_DELAY = 350;

// =========================================
// 2. 상태
// =========================================

let map = null;
let riskTools = null;
let riskReference = null;

let allAccidents = [];
let groupedAccidents = [];

let failedRequests = [];
let noDataRequests = [];

let completedRequests = 0;
let totalRequests = 75;
let requestCounter = 0;

let isLoading = false;
let isComplete = false;
let referenceIsPartial = true;

let markers = [];
let refreshTimer = null;
let hasFittedMap = false;

// overview / detail / closed
let panelMode = "overview";
let selectedAccidentKey = null;

const completedJobKeys = new Set();

const mapElement =
  document.getElementById("map");

const mapLayout =
  document.getElementById("mapLayout");

const detailPanel =
  document.getElementById("detailPanel");

const detailContent =
  document.getElementById("detailContent");

const districtSelect =
  document.getElementById("district");

const statusBox =
  document.getElementById("status");

// 기존 HTML의 onclick, onchange에 사용
window.applyFilter = applyFilter;
window.resetFilter = resetFilter;
window.closeDetailPanel = closeDetailPanel;
window.showSeoulOverview = showSeoulOverview;

// =========================================
// 3. 기본 함수
// =========================================

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmt(value) {
  return num(value).toLocaleString("ko-KR");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function getPanelTitle() {
  return (
    document.getElementById("detailTitle") ||
    detailPanel?.querySelector(".panel-title")
  );
}

function setPanelTitle(text) {
  const element = getPanelTitle();

  if (element) {
    element.textContent = text;
  }
}

function districtName(code) {
  if (code === "all") return "서울 전체";

  const option = Array.from(
    districtSelect.options
  ).find(item => item.value === code);

  return option ? option.textContent : code;
}

function isNoData(message) {
  return /NODATA_ERROR|NO_DATA/i.test(
    String(message || "")
  );
}

// =========================================
// 4. 패널 열기 및 닫기
// =========================================

function getOpenButton() {
  let button =
    document.getElementById("openOverviewButton");

  if (button) return button;

  // 기존 HTML에 버튼이 없는 경우 자동 생성
  button = makeElement(
    "button",
    "open-overview-button",
    "▤ 서울 전체 현황"
  );

  button.type = "button";
  button.id = "openOverviewButton";

  button.addEventListener(
    "click",
    showSeoulOverview
  );

  mapLayout.appendChild(button);

  return button;
}

function relayoutMap() {
  if (!map) return;

  requestAnimationFrame(() => {
    map.relayout();
  });
}

function openPanel() {
  if (!mapLayout) return;

  mapLayout.classList.add("active");

  const button = getOpenButton();
  button.hidden = true;

  relayoutMap();
}

function closeDetailPanel() {
  panelMode = "closed";
  selectedAccidentKey = null;

  mapLayout.classList.remove("active");

  const button = getOpenButton();
  button.hidden = false;

  relayoutMap();
}

// =========================================
// 5. 통계 카드 생성
// =========================================

function makeOverviewCard(label, value) {
  const card = makeElement("div", "overview-card");

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

function makeDetailRow(label, value) {
  const row = makeElement("div", "detail-row");

  row.append(
    makeElement("span", "detail-label", label),
    makeElement("span", "detail-value", value)
  );

  return row;
}

// =========================================
// 6. 서울 전체 자전거 사고 현황
// =========================================

function renderSeoulOverview() {
  if (panelMode !== "overview") return;

  setPanelTitle("서울 전체 자전거 사고 현황");

  detailContent.replaceChildren();

  const intro = makeElement(
    "p",
    "overview-lead",
    "2021~2023년 서울특별시의 자전거 " +
    "교통사고 다발지역 공공데이터를 분석한 " +
    "결과입니다. 사고지역과 인명피해 현황을 " +
    "확인할 수 있으며, 조회 중에도 결과가 " +
    "자동으로 갱신됩니다."
  );

  detailContent.appendChild(intro);

  const totalSpots = groupedAccidents.length;

  const totalAccidents =
    groupedAccidents.reduce(
      (sum, item) => sum + num(item.accidentCount),
      0
    );

  const totalCasualties =
    groupedAccidents.reduce(
      (sum, item) => sum + num(item.casualtyCount),
      0
    );

  const totalDeaths =
    groupedAccidents.reduce(
      (sum, item) => sum + num(item.deathCount),
      0
    );

  detailContent.appendChild(
    makeOverviewCard(
      "자전거 교통사고 다발지역",
      fmt(totalSpots) + "곳"
    )
  );

  const grid = makeElement("div", "overview-grid");

  grid.append(
    makeOverviewCard(
      "자전거 사고 건수",
      fmt(totalAccidents) + "건"
    ),
    makeOverviewCard(
      "사상자 수",
      fmt(totalCasualties) + "명"
    ),
    makeOverviewCard(
      "사망자 수",
      fmt(totalDeaths) + "명"
    ),
    makeOverviewCard(
      "분석 기간",
      "3개년"
    )
  );

  detailContent.appendChild(grid);

  detailContent.appendChild(
    makeElement(
      "h3",
      "overview-section-title",
      "자전거 사고지역 위험도 분포"
    )
  );

  const counts = {
    low: 0,
    medium: 0,
    high: 0,
    unknown: 0
  };

  groupedAccidents.forEach(item => {
    const level = riskReference
      ? riskTools.getRiskLevel(
          item.riskScore,
          riskReference
        )
      : "unknown";

    counts[level] = (counts[level] || 0) + 1;
  });

  [
    ["low", "주의"],
    ["medium", "높음"],
    ["high", "매우 높음"]
  ].forEach(([level, label]) => {
    const row = makeElement(
      "div",
      "overview-risk-row"
    );

    const name = makeElement(
      "span",
      "overview-risk-name"
    );

    name.append(
      makeElement(
        "span",
        "overview-dot " + level
      ),
      makeElement("span", "", label)
    );

    row.append(
      name,
      makeElement(
        "strong",
        "",
        fmt(counts[level]) + "곳"
      )
    );

    detailContent.appendChild(row);
  });

  const progress = makeElement(
    "p",
    "overview-progress"
  );

  if (!isComplete) {
    progress.textContent =
      `조회 진행 ${completedRequests}/${totalRequests}건\n` +
      "확인된 자전거 사고지역부터 반영 중";
  } else {
    progress.textContent =
      `조회 처리 완료 ${completedRequests}/${totalRequests}건\n` +
      `자료 없음 ${noDataRequests.length}건 · ` +
      `요청 실패 ${failedRequests.length}건`;
  }

  progress.style.whiteSpace = "pre-line";

  detailContent.appendChild(progress);

  detailContent.appendChild(
    makeElement(
      "p",
      "year-note",
      referenceIsPartial
        ? "위험도는 현재 확인된 자전거 사고지역의 " +
          "임시 상대 비교 기준입니다. " +
          "공식 위험등급은 아닙니다."
        : "서울 전체 자전거 사고다발지역의 " +
          "점수 분포를 기준으로 분류합니다. " +
          "공식 위험등급은 아닙니다."
    )
  );

  if (noDataRequests.length > 0 ||
      failedRequests.length > 0) {
    detailContent.appendChild(
      makeElement(
        "p",
        "year-note",
        "일부 연도·자치구에서 조회된 자료가 " +
        "없거나 요청이 실패했습니다. " +
        "표시된 통계는 확인된 기록의 합계입니다."
      )
    );
  }
}

function showSeoulOverview() {
  panelMode = "overview";
  selectedAccidentKey = null;

  renderSeoulOverview();
  openPanel();

  if (detailPanel) {
    detailPanel.scrollTop = 0;
  }
}

// =========================================
// 7. 개별 사고지역 상세정보
// =========================================

function showAccidentDetail(
  item,
  resetScroll = true
) {
  panelMode = "detail";
  selectedAccidentKey = item.key;

  setPanelTitle("자전거 사고지역 상세정보");

  detailContent.replaceChildren();

  // 새로 추가한 서울 전체 복귀 버튼
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

  detailContent.appendChild(backButton);

  detailContent.appendChild(
    makeElement(
      "h3",
      "region-name",
      item.name
    )
  );

  [
    ["자전거 사고 건수", item.accidentCount, "건"],
    ["사상자 수", item.casualtyCount, "명"],
    ["사망자 수", item.deathCount, "명"],
    ["중상자 수", item.seriousCount, "명"],
    ["경상자 수", item.minorCount, "명"],
    [
      "부상신고자 수",
      item.reportedInjuryCount,
      "명"
    ]
  ].forEach(([label, value, unit]) => {
    detailContent.appendChild(
      makeDetailRow(
        label,
        fmt(value) + unit
      )
    );
  });

  detailContent.appendChild(
    makeElement(
      "h4",
      "year-heading",
      "연도별 자전거 사고 현황"
    )
  );

  const table = makeElement("table", "year-table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");

  ["연도", "사고", "사상자"].forEach(text => {
    headRow.appendChild(
      makeElement("th", "", text)
    );
  });

  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const year of riskTools.RISK_YEARS) {
    const record = item.records[year];

    const key = year + "|" + item.districtCode;

    const failed = failedRequests.some(
      job => job.year === year &&
        job.district === item.districtCode
    );

    const noData = noDataRequests.some(
      job => job.year === year &&
        job.district === item.districtCode
    );

    const pending = !completedJobKeys.has(key);

    let values;

    if (record) {
      values = [
        year,
        fmt(record.accidentCount) + "건",
        fmt(record.casualtyCount) + "명"
      ];
    } else if (pending) {
      values = [year, "조회 중", "-"];
    } else if (failed) {
      values = [year, "조회 실패", "-"];
    } else if (noData) {
      values = [year, "자료 없음", "-"];
    } else {
      values = [year, "기록 없음", "-"];
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
  detailContent.appendChild(table);

  // 실제 위험도에 맞춰 카드 색상 변경
  const level = riskReference
    ? riskTools.getRiskLevel(
        item.riskScore,
        riskReference
      )
    : "unknown";

  const label = riskTools.getRiskLabel(
    item.riskScore,
    riskReference
  );

  const scoreBox = makeElement(
    "div",
    "score-box risk-" + level
  );

  scoreBox.append(
    makeElement(
      "div",
      "score-risk-label",
      label + " · 자전거 사고 상대적 위험도"
    ),
    makeElement(
      "strong",
      "score-number",
      fmt(item.riskScore) + "점"
    )
  );

  detailContent.appendChild(scoreBox);

  detailContent.appendChild(
    makeElement(
      "p",
      "score-caption",
      referenceIsPartial
        ? "조회된 자료 기준 임시 상대 위험도 · " +
          "공식 위험등급 아님"
        : "서울 전체 자전거 사고다발지역 기준 · " +
          "공식 위험등급 아님"
    )
  );

  detailContent.appendChild(
    makeElement(
      "p",
      "year-note",
      "기록 없음은 사고가 실제로 0건이었다는 " +
      "의미가 아니라, 해당 연도에 이 장소의 " +
      "사고다발지역 기록이 조회되지 않았다는 뜻입니다."
    )
  );

  openPanel();

  if (resetScroll && detailPanel) {
    detailPanel.scrollTop = 0;
  }
}

// =========================================
// 8. 캐시
// =========================================

function cacheKey(year, district) {
  return `bicycle_v3_${year}_${district}`;
}

function readCache(year, district) {
  try {
    const raw = localStorage.getItem(
      cacheKey(year, district)
    );

    if (!raw) return null;

    const saved = JSON.parse(raw);

    if (
      !saved ||
      !Array.isArray(saved.items) ||
      !Number.isFinite(saved.savedAt) ||
      Date.now() - saved.savedAt > CACHE_DURATION
    ) {
      return null;
    }

    return saved.items;
  } catch {
    return null;
  }
}

function saveCache(year, district, items) {
  try {
    localStorage.setItem(
      cacheKey(year, district),
      JSON.stringify({
        savedAt: Date.now(),
        items
      })
    );
  } catch (error) {
    console.warn("사고 데이터 캐시 저장 생략", error);
  }
}

// =========================================
// 9. GAS JSONP 통신
// =========================================

function requestJSONP(url) {
  return new Promise((resolve, reject) => {
    const callback =
      "bikeSafeMap_" + (++requestCounter);

    const script = document.createElement("script");
    let finished = false;

    const timer = setTimeout(() => {
      finish(new Error("TIMEOUT"));
    }, REQUEST_TIMEOUT);

    function finish(error, data) {
      if (finished) return;
      finished = true;

      clearTimeout(timer);
      script.remove();

      if (error) {
        // 지연 응답으로 발생하는 콜백 오류 방지
        window[callback] = function() {};
        reject(error);
      } else {
        delete window[callback];
        resolve(data);
      }
    }

    window[callback] = data => {
      finish(null, data);
    };

    script.onerror = () => {
      finish(new Error("NETWORK_ERROR"));
    };

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" +
      encodeURIComponent(callback);

    document.body.appendChild(script);
  });
}

// =========================================
// 10. 개별 데이터 조회
// =========================================

async function fetchAccidents(year, district) {
  const cached = readCache(year, district);

  if (cached !== null) {
    return {
      status: "success",
      items: cached
    };
  }

  const url =
    GAS_URL +
    "?year=" + encodeURIComponent(year) +
    "&sido=11" +
    "&gugun=" + encodeURIComponent(district);

  const result = await requestJSONP(url);

  if (result && result.success === true) {
    if (!Array.isArray(result.accidents)) {
      throw new Error("INVALID_DATA_FORMAT");
    }

    const items = result.accidents.map(item => ({
      ...item,
      year: String(year),
      districtCode: String(district)
    }));

    saveCache(year, district, items);

    return {
      status: "success",
      items
    };
  }

  const message = String(
    result && (result.error || result.message)
      ? result.error || result.message
      : "API_RESPONSE_ERROR"
  );

  if (isNoData(message)) {
    return {
      status: "nodata",
      items: []
    };
  }

  throw new Error(message);
}

async function fetchWithRetry(year, district) {
  let lastError = null;

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      if (attempt > 0) {
        await sleep(
          attempt * 900 + Math.random() * 300
        );
      }

      return await fetchAccidents(year, district);
    } catch (error) {
      lastError = error;

      if (isNoData(error.message)) {
        return {
          status: "nodata",
          items: []
        };
      }

      if (
        /SERVICE_KEY|INVALID_DATA_FORMAT|403|401/i
          .test(String(error.message))
      ) {
        break;
      }

      console.warn(
        `[자전거 사고 API] ${year}년 ` +
        `${districtName(district)} 조회 실패:`,
        error.message
      );
    }
  }

  return {
    status: "failed",
    items: [],
    reason: lastError
      ? lastError.message
      : "UNKNOWN_ERROR"
  };
}

// =========================================
// 11. 서울 전체 위험도 기준
// =========================================

function updateRiskReference() {
  groupedAccidents =
    riskTools.groupRiskAccidents(allAccidents);

  if (!groupedAccidents.length) {
    riskReference =
      riskTools.readRiskReference();

    referenceIsPartial = !riskReference;
    updateLegend();
    return;
  }

  const calculated =
    riskTools.createRiskReference(
      groupedAccidents
    );

  if (
    isComplete &&
    failedRequests.length === 0
  ) {
    riskReference = calculated;
    referenceIsPartial = false;

    // 정상 완료된 기준만 공유 캐시에 저장
    riskTools.saveRiskReference(riskReference);
  } else {
    const saved = riskTools.readRiskReference();

    riskReference = saved || calculated;
    referenceIsPartial = !saved;
  }

  updateLegend();
}

function updateLegend() {
  const legend = document.querySelector(
    ".risk-legend-bar"
  );

  if (!legend || !riskTools) return;

  const ranges = riskTools.getRiskRanges(
    riskReference
  );

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

  const subtitle = legend.querySelector(
    ".legend-heading span"
  );

  if (subtitle) {
    subtitle.textContent = referenceIsPartial
      ? "확인된 자료의 임시 기준"
      : "서울 전체 백분위 기준";
  }
}

// =========================================
// 12. 카카오맵 마커
// =========================================

function clearMarkers() {
  markers.forEach(marker => marker.setMap(null));
  markers = [];
}

function getFilteredGroups() {
  const district = districtSelect.value;

  return district === "all"
    ? groupedAccidents
    : groupedAccidents.filter(
        item => item.districtCode === district
      );
}

function displayMarkers(fitBounds = false) {
  if (!map || !riskTools) return;

  clearMarkers();

  const items = getFilteredGroups();
  const bounds = new kakao.maps.LatLngBounds();

  const positions = [];

  items.forEach(item => {
    if (
      item.latitude == null ||
      item.longitude == null
    ) {
      return;
    }

    const position = new kakao.maps.LatLng(
      item.latitude,
      item.longitude
    );

    const level = riskReference
      ? riskTools.getRiskLevel(
          item.riskScore,
          riskReference
        )
      : "unknown";

    const button = makeElement(
      "button",
      "risk-marker " +
      (level === "unknown" ? "" : level)
    );

    button.type = "button";

    if (level === "unknown") {
      button.style.backgroundColor = "#94a3b8";
    }

    button.title =
      `${item.name} · 자전거 사고 위험도 ` +
      `${fmt(item.riskScore)}점`;

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
    markers.push(overlay);

    positions.push(position);
    bounds.extend(position);
  });

  if (fitBounds && positions.length > 0) {
    if (positions.length === 1) {
      map.setCenter(positions[0]);
      map.setLevel(5);
    } else {
      map.setBounds(bounds, 50, 50, 70, 50);
    }
  }

  setText("spotCount", fmt(items.length));

  setText(
    "accidentCount",
    fmt(items.reduce(
      (sum, item) => sum + num(item.accidentCount),
      0
    ))
  );

  setText(
    "casualtyCount",
    fmt(items.reduce(
      (sum, item) => sum + num(item.casualtyCount),
      0
    ))
  );

  setText(
    "currentRegion",
    districtName(districtSelect.value)
  );
}

// =========================================
// 13. 로딩 화면 갱신
// =========================================

function updateStatus() {
  if (!statusBox) return;

  if (!isComplete) {
    statusBox.textContent =
      `자전거 사고지역 조회 중 ` +
      `${completedRequests}/${totalRequests}건`;
  } else {
    statusBox.textContent =
      `자전거 사고지역 조회 완료 · ` +
      `자료 없음 ${noDataRequests.length}건 · ` +
      `요청 실패 ${failedRequests.length}건`;
  }
}

function refreshScreen() {
  if (!riskTools) return;

  updateRiskReference();

  const shouldFit =
    !hasFittedMap &&
    groupedAccidents.length > 0;

  displayMarkers(shouldFit);

  if (shouldFit) {
    hasFittedMap = true;
  }

  if (panelMode === "overview") {
    // 스크롤 위치를 유지한 채 내용 갱신
    const scroll = detailPanel.scrollTop;

    renderSeoulOverview();

    detailPanel.scrollTop = scroll;
  } else if (panelMode === "detail") {
    const selected = groupedAccidents.find(
      item => item.key === selectedAccidentKey
    );

    if (selected) {
      const scroll = detailPanel.scrollTop;

      showAccidentDetail(selected, false);

      detailPanel.scrollTop = scroll;
    }
  }

  updateStatus();
}

function scheduleRefresh(force = false) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  if (force) {
    refreshScreen();
    return;
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshScreen();
  }, UPDATE_DELAY);
}

// =========================================
// 14. 지역 필터
// =========================================

function applyFilter() {
  if (!map || !riskTools) return;

  // 지도만 선택 지역으로 변경
  // 서울 전체 자전거 사고 통계는 유지
  if (panelMode === "detail") {
    showSeoulOverview();
  }

  displayMarkers(true);
  updateStatus();
}

function resetFilter() {
  if (!districtSelect) return;

  districtSelect.value = "all";
  applyFilter();
}

// =========================================
// 15. 요청 결과 저장
// =========================================

function acceptResult(job, result) {
  completedJobKeys.add(
    job.year + "|" + job.district
  );

  if (result.status === "success") {
    allAccidents.push(...result.items);
  } else if (result.status === "nodata") {
    noDataRequests.push(job);
  } else {
    failedRequests.push({
      ...job,
      reason: result.reason || "UNKNOWN_ERROR"
    });
  }

  completedRequests++;

  if (
    result.status === "success" &&
    result.items.length > 0
  ) {
    scheduleRefresh();
  } else if (panelMode === "overview") {
    renderSeoulOverview();
  }

  updateStatus();
}

// =========================================
// 16. 서울 자전거 사고 데이터 조회
// =========================================

async function loadSeoulData() {
  if (isLoading) return;

  isLoading = true;

  const jobs = [];

  for (const year of riskTools.RISK_YEARS) {
    for (const district of riskTools.RISK_DISTRICTS) {
      jobs.push({ year, district });
    }
  }

  totalRequests = jobs.length;

  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];

      const result = await fetchWithRetry(
        job.year,
        job.district
      );

      acceptResult(job, result);
    }
  }

  try {
    await Promise.all(
      Array.from(
        { length: CONCURRENT_REQUESTS },
        () => worker()
      )
    );
  } finally {
    isLoading = false;
    isComplete = true;

    scheduleRefresh(true);

    window.BIKE_SAFE_FAILED_REQUESTS =
      failedRequests;

    window.BIKE_SAFE_NODATA_REQUESTS =
      noDataRequests;

    console.group("BIKE SAFE 자전거 사고 데이터");

    console.log({
      totalRequests,
      noData: noDataRequests.length,
      failed: failedRequests.length,
      accidentRegions: groupedAccidents.length
    });

    if (failedRequests.length) {
      console.table(failedRequests);
    }

    console.groupEnd();
  }
}

// =========================================
// 17. 페이지 시작
// =========================================

window.addEventListener("load", async () => {
  if (
    !mapElement ||
    !mapLayout ||
    !detailPanel ||
    !detailContent ||
    !districtSelect ||
    !statusBox
  ) {
    console.error(
      "BIKE SAFE 필수 HTML 요소를 찾지 못했습니다."
    );
    return;
  }

  // HTML에서 버튼이 이미 있거나 없어도 작동
  getOpenButton();

  // 첫 화면은 서울 전체 자전거 사고 현황
  panelMode = "overview";
  mapLayout.classList.add("active");
  getOpenButton().hidden = true;

  setPanelTitle("서울 전체 자전거 사고 현황");

  if (!window.kakao || !kakao.maps) {
    detailContent.textContent =
      "카카오맵을 불러오지 못했습니다.";
    return;
  }

  try {
    riskTools = await import("./risk.js");
  } catch (error) {
    detailContent.textContent =
      "위험도 분석 파일을 불러오지 못했습니다.";
    console.error(error);
    return;
  }

  map = new kakao.maps.Map(mapElement, {
    center: new kakao.maps.LatLng(
      MAP_CENTER.lat,
      MAP_CENTER.lng
    ),
    level: 9
  });

  relayoutMap();

  riskReference =
    riskTools.readRiskReference();

  referenceIsPartial = !riskReference;

  renderSeoulOverview();
  updateLegend();

  if (
    !GAS_URL.startsWith(
      "https://script.google.com/macros/s/"
    ) ||
    !GAS_URL.endsWith("/exec")
  ) {
    detailContent.textContent =
      "Google Apps Script 주소를 확인해 주세요.";
    return;
  }

  await loadSeoulData();
});
