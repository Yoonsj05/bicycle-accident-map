
/*
  BIKE SAFE - 서울 자전거 사고 지도

  [기존 기능]
  - 2021~2023년 서울 사고지역 조회
  - 성공한 요청부터 마커 표시
  - NODATA_ERROR 분리 처리
  - 일시적 오류 자동 재시도
  - 서울 전체 백분위 위험도
  - 자치구 필터와 사고지역 상세정보

  [새로운 기능]
  - 처음 접속하면 서울 전체 현황 패널 열림
  - 데이터가 들어올 때마다 현황 자동 갱신
  - 마커 클릭하면 개별 사고정보로 전환
  - X 버튼으로 패널 닫기
  - 서울 전체 현황 버튼으로 다시 열기
  - 패널 열기/닫기에 맞춰 지도 크기 재계산
*/

// ========================================
// 1. 설정
// ========================================

// 기존에 사용하던 GAS /exec 주소로 교체
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

let map = null;
let riskTools = null;
let riskReference = null;

let allAccidents = [];
let groupedAccidents = [];

let failedRequests = [];
let noDataRequests = [];

let requestCounter = 0;
let completedRequests = 0;
let totalRequests = 75;

let isLoading = false;
let isComplete = false;
let referenceIsPartial = true;
let hasFittedMap = false;

let markers = [];
let updateTimer = null;

// 현재 패널 상태: overview / detail / closed
let panelMode = "overview";
let selectedAccidentKey = null;

const mapElement =
  document.getElementById("map");

const mapLayout =
  document.getElementById("mapLayout");

const detailPanel =
  document.getElementById("detailPanel");

const detailContent =
  document.getElementById("detailContent");

const detailTitle =
  document.getElementById("detailTitle");

const districtSelect =
  document.getElementById("district");

const statusBox =
  document.getElementById("status");

const openOverviewButton =
  document.getElementById("openOverviewButton");

// HTML onclick/onchange에서 사용
window.applyFilter = applyFilter;
window.resetFilter = resetFilter;
window.closeDetailPanel = closeDetailPanel;
window.showSeoulOverview = showSeoulOverview;

// ========================================
// 2. 기본 함수
// ========================================

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmt(value) {
  return num(value).toLocaleString("ko-KR");
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isNoData(message) {
  return /NODATA_ERROR|NO_DATA/i.test(
    String(message || "")
  );
}

function districtName(code) {
  if (code === "all") return "서울 전체";

  const option = Array.from(
    districtSelect.options
  ).find(item => item.value === code);

  return option ? option.textContent : code;
}

// ========================================
// 3. 캐시
// ========================================

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
  } catch (error) {
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
    console.warn("캐시 저장 생략", error);
  }
}

// ========================================
// 4. JSONP 요청
// ========================================

function requestJSONP(url) {
  return new Promise((resolve, reject) => {
    const callback =
      "bikeSafePanel_" + (++requestCounter);

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
        window[callback] = function() {};
        reject(error);
      } else {
        delete window[callback];
        resolve(data);
      }
    }

    window[callback] = data => finish(null, data);

    script.onerror = () => {
      finish(new Error("NETWORK_ERROR"));
    };

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" + encodeURIComponent(callback);

    document.body.appendChild(script);
  });
}

// ========================================
// 5. 개별 사고지역 조회
// ========================================

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

// ========================================
// 6. 일시적 오류 재시도
// ========================================

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
        `[BIKE SAFE] ${year}년 ` +
        `${districtName(district)} 요청 오류:`,
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

// ========================================
// 7. 패널을 열고 닫을 때 지도 재계산
// ========================================

function relayoutMap() {
  if (!map) return;

  // CSS에서 #map의 실제 너비가 변경됐으므로
  // 카카오맵 내부 크기도 새로 계산
  requestAnimationFrame(() => {
    map.relayout();

    // 가운데 위치 유지. 지도 위치는 사용자가
    // 보고 있던 좌표를 그대로 사용
  });
}

function openPanel() {
  mapLayout.classList.add("active");

  if (openOverviewButton) {
    openOverviewButton.hidden = true;
  }

  relayoutMap();
}

function closeDetailPanel() {
  panelMode = "closed";
  selectedAccidentKey = null;

  mapLayout.classList.remove("active");

  if (openOverviewButton) {
    openOverviewButton.hidden = false;
  }

  relayoutMap();
}

// ========================================
// 8. 패널용 HTML 요소 만들기
// ========================================

function makeElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = String(text);
  }

  return element;
}

function makeOverviewCard(label, value) {
  const card = makeElement("div", "overview-card");

  const title = makeElement(
    "span",
    "overview-label",
    label
  );

  const number = makeElement(
    "strong",
    "overview-number",
    value
  );

  card.append(title, number);
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

// ========================================
// 9. 서울 전체 사고 현황
// ========================================

function renderSeoulOverview() {
  if (panelMode !== "overview") return;

  detailTitle.textContent = "서울 전체 사고 현황";
  detailContent.replaceChildren();

  const intro = makeElement(
    "p",
    "overview-lead",
    "2021~2023년 서울 사고다발지역 자료를 " +
    "기준으로 집계한 현황이에요. " +
    "데이터가 들어오면 숫자가 자동으로 갱신돼요."
  );

  detailContent.appendChild(intro);

  const totalSpots = groupedAccidents.length;

  const totalAccidents = groupedAccidents.reduce(
    (sum, item) => sum + num(item.accidentCount),
    0
  );

  const totalCasualties = groupedAccidents.reduce(
    (sum, item) => sum + num(item.casualtyCount),
    0
  );

  const totalDeaths = groupedAccidents.reduce(
    (sum, item) => sum + num(item.deathCount),
    0
  );

  detailContent.appendChild(
    makeOverviewCard(
      "사고다발지역",
      fmt(totalSpots) + "곳"
    )
  );

  const statsGrid = makeElement(
    "div",
    "overview-grid"
  );

  statsGrid.append(
    makeOverviewCard(
      "사고 건수",
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
      "분석 연도",
      "3개년"
    )
  );

  detailContent.appendChild(statsGrid);

  const riskHeading = makeElement(
    "h3",
    "overview-section-title",
    "사고지역 위험도 분포"
  );

  detailContent.appendChild(riskHeading);

  const counts = {
    low: 0,
    medium: 0,
    high: 0,
    unknown: 0
  };

  groupedAccidents.forEach(item => {
    const level = riskTools
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

    const nameBox = makeElement(
      "span",
      "overview-risk-name"
    );

    nameBox.append(
      makeElement(
        "span",
        "overview-dot " + level
      ),
      makeElement("span", "", label)
    );

    row.append(
      nameBox,
      makeElement(
        "strong",
        "",
        fmt(counts[level]) + "곳"
      )
    );

    detailContent.appendChild(row);
  });

  const progress = makeElement(
    "div",
    "overview-progress"
  );

  let message;

  if (!isComplete) {
    message =
      `데이터 조회 중 ${completedRequests}/${totalRequests}건` +
      "\n성공한 사고지역부터 표시하고 있어요.";
  } else {
    message =
      `조회 처리 완료 ${completedRequests}/${totalRequests}건` +
      `\n자료 없음 ${noDataRequests.length}건` +
      ` · 요청 실패 ${failedRequests.length}건`;
  }

  progress.textContent = message;
  progress.style.whiteSpace = "pre-line";

  detailContent.appendChild(progress);

  if (referenceIsPartial) {
    detailContent.appendChild(
      makeElement(
        "p",
        "year-note",
        "현재 위험도는 조회된 데이터의 임시 백분위 " +
        "기준일 수 있어요. 공식 위험등급은 아니에요."
      )
    );
  }
}

function showSeoulOverview() {
  panelMode = "overview";
  selectedAccidentKey = null;

  openPanel();
  renderSeoulOverview();

  if (detailPanel) {
    detailPanel.scrollTop = 0;
  }
}

// ========================================
// 10. 개별 사고지역 상세정보
// ========================================

function showAccidentDetail(item, resetScroll = true) {
  panelMode = "detail";
  selectedAccidentKey = item.key;

  detailTitle.textContent = "사고지역 상세정보";
  detailContent.replaceChildren();

  detailContent.appendChild(
    makeElement("h3", "region-name", item.name)
  );

  [
    ["사고 건수", item.accidentCount, "건"],
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
      "연도별 사고 현황"
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

    const failed = failedRequests.some(
      job =>
        job.year === year &&
        job.district === item.districtCode
    );

    const pending =
      !isComplete &&
      !completedJobKeys.has(
        year + "|" + item.districtCode
      );

    const values = pending
      ? [year, "조회 중", "-"]
      : failed
        ? [year, "조회 실패", "-"]
        : record
          ? [
              year,
              fmt(record.accidentCount) + "건",
              fmt(record.casualtyCount) + "명"
            ]
          : [year, "기록 없음", "-"];

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

  const scoreBox = makeElement(
    "div",
    "score-box"
  );

  const riskLabel = riskTools.getRiskLabel(
    item.riskScore,
    riskReference
  );

  scoreBox.append(
    makeElement(
      "div",
      "",
      riskLabel + " · 상대적 위험도"
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
        ? "조회 중인 자료 기준 임시 위험도"
        : "서울 전체 기준 · 공식 위험등급 아님"
    )
  );

  openPanel();

  if (resetScroll) {
    detailPanel.scrollTop = 0;
  }
}

// ========================================
// 11. 위험도 기준 계산
// ========================================

function updateRiskReference() {
  groupedAccidents =
    riskTools.groupRiskAccidents(
      allAccidents
    );

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

  // NODATA_ERROR는 조회 자료 없음이고
  // 실제 통신 실패와 구분
  if (isComplete && failedRequests.length === 0) {
    riskReference = calculated;
    referenceIsPartial = false;

    riskTools.saveRiskReference(
      riskReference
    );
  } else {
    const saved =
      riskTools.readRiskReference();

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

  const ranges =
    riskTools.getRiskRanges(riskReference);

  const labels = [
    "주의 · " + ranges.low,
    "높음 · " + ranges.medium,
    "매우 높음 · " + ranges.high
  ];

  legend.querySelectorAll(
    ".legend-segment"
  ).forEach((segment, index) => {
    const text = segment.querySelector("span");

    if (text) {
      text.textContent = labels[index];
    }
  });

  const subtitle = legend.querySelector(
    ".legend-heading span"
  );

  if (subtitle) {
    subtitle.textContent = referenceIsPartial
      ? "조회된 데이터 임시 기준"
      : "서울 전체 백분위 기준";
  }
}

// ========================================
// 12. 지도 마커 표시
// ========================================

function clearMarkers() {
  markers.forEach(item => {
    item.setMap(null);
  });

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

    const level = riskTools.getRiskLevel(
      item.riskScore,
      riskReference
    );

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
      `${item.name} · ${fmt(item.riskScore)}점`;

    button.setAttribute(
      "aria-label",
      button.title
    );

    button.addEventListener("click", () => {
      const wasClosed =
        panelMode === "closed";

      showAccidentDetail(item);

      if (wasClosed) {
        // 패널 열림으로 지도 너비가 변한 뒤 이동
        requestAnimationFrame(() => {
          map.relayout();
          map.panTo(position);
        });
      } else {
        map.panTo(position);
      }
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
    fmt(
      items.reduce(
        (sum, item) =>
          sum + num(item.accidentCount),
        0
      )
    )
  );

  setText(
    "casualtyCount",
    fmt(
      items.reduce(
        (sum, item) =>
          sum + num(item.casualtyCount),
        0
      )
    )
  );

  setText(
    "currentRegion",
    districtName(districtSelect.value)
  );
}

// ========================================
// 13. 데이터 변화 시 화면 갱신
// ========================================

function updateStatus() {
  const message = !isComplete
    ? `조회 중 ${completedRequests}/${totalRequests}` +
      " · 성공한 데이터부터 표시 중"
    : `조회 완료 · 자료 없음 ${noDataRequests.length}건` +
      ` · 실제 실패 ${failedRequests.length}건`;

  if (statusBox) {
    statusBox.textContent = message;
  }
}

function refreshScreen() {
  if (!riskTools) return;

  updateRiskReference();
  displayMarkers(false);

  if (!hasFittedMap && groupedAccidents.length > 0) {
    hasFittedMap = true;
    displayMarkers(true);
  }

  if (panelMode === "overview") {
    renderSeoulOverview();
  } else if (panelMode === "detail") {
    const selected = groupedAccidents.find(
      item => item.key === selectedAccidentKey
    );

    if (selected) {
      const oldScroll = detailPanel.scrollTop;

      showAccidentDetail(selected, false);

      detailPanel.scrollTop = oldScroll;
    }
  }

  updateStatus();
}

function scheduleRefresh(force = false) {
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }

  if (force) {
    refreshScreen();
    return;
  }

  updateTimer = setTimeout(() => {
    updateTimer = null;
    refreshScreen();
  }, UPDATE_DELAY);
}

// ========================================
// 14. 자치구 필터
// ========================================

function applyFilter() {
  if (!map || !riskTools) return;

  // 패널이 열려 있다면 서울 전체 현황으로 복귀
  // 서울 전체 집계는 자치구 선택과 관계없이 유지
  if (panelMode !== "closed") {
    panelMode = "overview";
    selectedAccidentKey = null;

    renderSeoulOverview();
  }

  displayMarkers(true);
  updateStatus();
}

function resetFilter() {
  districtSelect.value = "all";
  applyFilter();
}

// ========================================
// 15. 데이터 조회 결과 반영
// ========================================

const completedJobKeys = new Set();

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
    // 수치가 변하지 않아도 조회 진행 상태 갱신
    renderSeoulOverview();
  }

  updateStatus();
}

// ========================================
// 16. 서울 전체 실시간 조회
// ========================================

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

    console.group("BIKE SAFE 조회 결과");

    console.log(
      `전체 ${totalRequests}건`,
      `자료 없음 ${noDataRequests.length}건`,
      `실패 ${failedRequests.length}건`
    );

    if (noDataRequests.length) {
      console.table(noDataRequests);
    }

    if (failedRequests.length) {
      console.table(failedRequests);
    }

    console.groupEnd();
  }
}

// ========================================
// 17. 페이지 실행
// ========================================

window.addEventListener("load", async () => {
  if (
    !mapElement ||
    !mapLayout ||
    !detailContent ||
    !detailTitle ||
    !districtSelect ||
    !statusBox
  ) {
    return;
  }

  // 첫 화면의 기본 패널 표시
  mapLayout.classList.add("active");

  if (openOverviewButton) {
    openOverviewButton.hidden = true;
  }

  if (!window.kakao || !kakao.maps) {
    statusBox.textContent =
      "카카오맵 SDK를 불러오지 못했어요.";

    detailContent.textContent =
      "지도 서비스 연결을 확인해 주세요.";

    return;
  }

  try {
    riskTools = await import("./risk.js");
  } catch (error) {
    statusBox.textContent =
      "js/risk.js 파일을 불러오지 못했어요.";

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

  // 처음부터 왼쪽 패널이 열려 있는 크기로 계산
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
      "GAS 웹 앱 URL 설정을 확인해 주세요.";

    statusBox.textContent =
      "GAS 웹 앱 URL이 설정되지 않았어요.";

    return;
  }

  // 서울 전체 데이터를 계속 받아가며 갱신
  await loadSeoulData();
});
