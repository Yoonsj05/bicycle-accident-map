
/*
  BIKE SAFE - 실시간 순차 갱신 지도

  - 성공한 데이터부터 지도 표시
  - 데이터가 추가되면 지도 자동 갱신
  - NODATA_ERROR는 자료 없음으로 처리
  - 일시적 오류만 재시도
  - 서울 전체 백분위수 위험도 계산
  - 기존 HTML/CSS 구조 유지
*/

// =========================================
// 1. 환경 설정
// =========================================

// 기존에 사용 중이던 Google Apps Script /exec URL
const GAS_URL = "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

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
let successfulRequests = 0;
let totalRequests = 75;
let completedRequests = 0;

let markers = [];
let requestCounter = 0;
let isLoading = false;
let isComplete = false;
let hasMovedToData = false;
let selectedAccidentKey = null;
let referenceIsPartial = true;
let updateTimer = null;

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

window.applyFilter = applyFilter;
window.resetFilter = resetFilter;
window.closeDetailPanel = closeDetailPanel;

// =========================================
// 2. 공통 함수
// =========================================

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmt(value) {
  return num(value).toLocaleString("ko-KR");
}

function setText(id, value) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = value;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function districtName(code) {
  const option = Array.from(
    districtSelect.options
  ).find(option => option.value === code);

  return option ? option.textContent : code;
}

function isNoDataError(message) {
  return /NODATA_ERROR|NO_DATA/i.test(
    String(message || "")
  );
}

function cacheKey(year, district) {
  return `bicycle_v3_${year}_${district}`;
}

// =========================================
// 3. 캐시
// =========================================

function readCache(year, district) {
  try {
    const text = localStorage.getItem(
      cacheKey(year, district)
    );

    if (!text) return null;

    const saved = JSON.parse(text);

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
    console.warn("캐시 저장 생략", error);
  }
}

// =========================================
// 4. JSONP 요청
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
        // 늦게 도착한 JSONP 응답에 대비
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

// =========================================
// 5. 개별 요청
// =========================================

async function fetchAccidents(year, district) {
  const cached = readCache(year, district);

  if (cached !== null) {
    return {
      status: "success",
      items: cached,
      fromCache: true
    };
  }

  const url =
    GAS_URL +
    "?year=" + encodeURIComponent(year) +
    "&sido=11" +
    "&gugun=" + encodeURIComponent(district);

  const result = await requestJSONP(url);

  if (result && result.success === true) {
    const accidents = Array.isArray(result.accidents)
      ? result.accidents
      : null;

    if (!accidents) {
      throw new Error("INVALID_DATA_FORMAT");
    }

    const items = accidents.map(item => ({
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

  if (isNoDataError(message)) {
    return {
      status: "nodata",
      items: []
    };
  }

  throw new Error(message);
}

// =========================================
// 6. 재시도
// =========================================

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
          attempt * 900 +
          Math.random() * 300
        );
      }

      return await fetchAccidents(
        year,
        district
      );

    } catch (error) {
      lastError = error;

      const message = String(error.message || "");

      // 데이터 없음은 재시도 대상 아님
      if (isNoDataError(message)) {
        return {
          status: "nodata",
          items: []
        };
      }

      // 인증·설정·형식 오류도 계속 재시도하지 않음
      if (
        /SERVICE_KEY|INVALID_DATA_FORMAT|403|401/i
          .test(message)
      ) {
        break;
      }

      console.warn(
        `[지도] ${year}년 ${districtName(district)} ` +
        `${attempt + 1}회 실패: ${message}`
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
// 7. 현재까지 받은 데이터로 위험도 계산
// =========================================

function calculateCurrentRisk() {
  groupedAccidents =
    riskTools.groupRiskAccidents(allAccidents);

  if (!groupedAccidents.length) {
    riskReference = null;
    return;
  }

  // 로딩 도중에는 현재 데이터 기준 임시 경계
  const provisional =
    riskTools.createRiskReference(
      groupedAccidents
    );

  if (
    isComplete &&
    failedRequests.length === 0
  ) {
    // 모든 요청이 정상 처리됐을 때 정식 경계
    riskReference = provisional;
    referenceIsPartial = false;

    riskTools.saveRiskReference(riskReference);
  } else {
    // 기존 완전한 서울 기준이 있다면 우선 사용
    const saved = riskTools.readRiskReference();

    if (saved) {
      riskReference = saved;
      referenceIsPartial = false;
    } else {
      riskReference = provisional;
      referenceIsPartial = true;
    }
  }

  updateLegend();
}

// =========================================
// 8. 위험도 범례
// =========================================

function updateLegend() {
  const legend = document.querySelector(
    ".risk-legend-bar"
  );

  if (!legend || !riskTools) return;

  const ranges = riskTools.getRiskRanges(
    riskReference
  );

  const labels = [
    `주의 · ${ranges.low}`,
    `높음 · ${ranges.medium}`,
    `매우 높음 · ${ranges.high}`
  ];

  legend.querySelectorAll(
    ".legend-segment"
  ).forEach((segment, index) => {
    const label = segment.querySelector("span");

    if (label) {
      label.textContent = labels[index];
    }
  });

  const subtitle = legend.querySelector(
    ".legend-heading span"
  );

  if (subtitle) {
    subtitle.textContent = !riskReference
      ? "데이터 로딩 중"
      : referenceIsPartial
        ? "조회된 데이터 임시 기준"
        : "서울 전체 고정 기준";
  }
}

// =========================================
// 9. 로딩 상태 표시
// =========================================

function updateStatus() {
  if (!statusBox) return;

  const region = districtSelect.value === "all"
    ? "서울 전체"
    : districtName(districtSelect.value);

  const count = groupedAccidents.filter(
    item =>
      districtSelect.value === "all" ||
      item.districtCode === districtSelect.value
  ).length;

  if (!isComplete) {
    statusBox.textContent =
      `조회 중 ${completedRequests}/${totalRequests}` +
      ` · ${region} ${count}곳 표시` +
      ` · 데이터가 들어오면 자동 갱신`;
  } else {
    statusBox.textContent =
      `${region} · 사고다발지역 ${count}곳` +
      ` · 자료 없음 ${noDataRequests.length}건` +
      (
        failedRequests.length
          ? ` · 실제 요청 실패 ${failedRequests.length}건`
          : ""
      ) +
      (
        referenceIsPartial
          ? " · 임시 위험도 기준"
          : ""
      );
  }
}

// =========================================
// 10. 마커 제거
// =========================================

function clearMarkers() {
  markers.forEach(marker => marker.setMap(null));
  markers = [];
}

// =========================================
// 11. 지도 갱신
// =========================================

function displayMarkers({
  fitBounds = false,
  preserveDetail = true
} = {}) {
  if (!map || !riskTools) return;

  const district = districtSelect.value;

  const items = district === "all"
    ? groupedAccidents
    : groupedAccidents.filter(
        item => item.districtCode === district
      );

  clearMarkers();

  const bounds = new kakao.maps.LatLngBounds();
  const positions = [];

  for (const item of items) {
    if (
      item.latitude == null ||
      item.longitude == null
    ) {
      continue;
    }

    const position = new kakao.maps.LatLng(
      item.latitude,
      item.longitude
    );

    const level = riskTools.getRiskLevel(
      item.riskScore,
      riskReference
    );

    const button = document.createElement("button");

    button.type = "button";
    button.className =
      "risk-marker " +
      (level === "unknown" ? "" : level);

    if (level === "unknown") {
      button.style.background = "#94a3b8";
    }

    button.title =
      `${item.name} · ${fmt(item.riskScore)}점 · ` +
      riskTools.getRiskLabel(
        item.riskScore,
        riskReference
      );

    button.setAttribute(
      "aria-label",
      button.title
    );

    const overlay = new kakao.maps.CustomOverlay({
      position,
      content: button,
      yAnchor: 0.5,
      zIndex: 3
    });

    button.addEventListener("click", () => {
      selectedAccidentKey = item.key;

      showAccidentDetail(item);
      map.panTo(position);
    });

    overlay.setMap(map);
    markers.push(overlay);

    positions.push(position);
    bounds.extend(position);
  }

  // 사용자 지도를 보고 있는 도중
  // 데이터 추가로 지도 위치를 반복 변경하지 않음
  if (fitBounds && positions.length) {
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
    district === "all"
      ? "서울 전체"
      : districtName(district)
  );

  // 사용자가 열어둔 상세정보를 그대로 갱신
  if (preserveDetail && selectedAccidentKey) {
    const selected = items.find(
      item => item.key === selectedAccidentKey
    );

    if (selected) {
      showAccidentDetail(selected);
    } else {
      closeDetailPanel();
    }
  }

  updateStatus();
}

// =========================================
// 12. 화면 갱신 예약
// =========================================

function scheduleUpdate(force = false) {
  if (updateTimer) {
    clearTimeout(updateTimer);
  }

  if (force) {
    refreshMap();
    return;
  }

  updateTimer = setTimeout(() => {
    updateTimer = null;
    refreshMap();
  }, UPDATE_DELAY);
}

function refreshMap() {
  calculateCurrentRisk();

  const shouldFit =
    !hasMovedToData &&
    allAccidents.length > 0 &&
    markers.length === 0;

  displayMarkers({
    fitBounds: shouldFit,
    preserveDetail: true
  });

  if (shouldFit) {
    hasMovedToData = true;
  }
}

// =========================================
// 13. 상세정보 표 생성
// =========================================

function detailRow(label, value) {
  const row = document.createElement("div");
  row.className = "detail-row";

  const labelSpan = document.createElement("span");
  labelSpan.className = "detail-label";
  labelSpan.textContent = label;

  const valueSpan = document.createElement("span");
  valueSpan.className = "detail-value";
  valueSpan.textContent = value;

  row.append(labelSpan, valueSpan);
  return row;
}

function showAccidentDetail(item) {
  if (!detailContent) return;

  detailContent.replaceChildren();

  const heading = document.createElement("h3");
  heading.className = "region-name";
  heading.textContent = item.name;
  detailContent.appendChild(heading);

  const rows = [
    ["사고 건수", item.accidentCount, "건"],
    ["사상자 수", item.casualtyCount, "명"],
    ["사망자 수", item.deathCount, "명"],
    ["중상자 수", item.seriousCount, "명"],
    ["경상자 수", item.minorCount, "명"],
    ["부상신고자 수", item.reportedInjuryCount, "명"]
  ];

  rows.forEach(([label, value, unit]) => {
    detailContent.appendChild(
      detailRow(label, fmt(value) + unit)
    );
  });

  const tableHeading = document.createElement("h4");
  tableHeading.className = "year-heading";
  tableHeading.textContent = "연도별 사고 현황";
  detailContent.appendChild(tableHeading);

  const table = document.createElement("table");
  table.className = "year-table";

  const thead = document.createElement("thead");
  const headingRow = document.createElement("tr");

  ["연도", "사고", "사상자"].forEach(value => {
    const th = document.createElement("th");
    th.textContent = value;
    headingRow.appendChild(th);
  });

  thead.appendChild(headingRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const year of riskTools.RISK_YEARS) {
    const record = item.records[year];

    const failed = failedRequests.some(
      job =>
        job.year === year &&
        job.district === item.districtCode
    );

    const values = failed
      ? [year, "조회 실패", "-"]
      : record
        ? [
            year,
            fmt(record.accidentCount) + "건",
            fmt(record.casualtyCount) + "명"
          ]
        : [year, "조회 기록 없음", "-"];

    const tr = document.createElement("tr");

    values.forEach(value => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  detailContent.appendChild(table);

  const scoreBox = document.createElement("div");
  scoreBox.className = "score-box";

  const scoreLabel = document.createElement("div");
  scoreLabel.textContent =
    riskTools.getRiskLabel(
      item.riskScore,
      riskReference
    ) + " · 상대적 위험도";

  const score = document.createElement("strong");
  score.className = "score-number";
  score.textContent = fmt(item.riskScore) + "점";

  scoreBox.append(scoreLabel, score);
  detailContent.appendChild(scoreBox);

  const note = document.createElement("p");
  note.className = "score-caption";
  note.textContent = referenceIsPartial
    ? "현재까지 조회된 자료에 따른 임시 등급"
    : "서울 전체 기준 · 공식 위험등급 아님";

  detailContent.appendChild(note);

  if (mapLayout) {
    mapLayout.classList.add("active");
  }
}

function closeDetailPanel() {
  selectedAccidentKey = null;

  if (mapLayout) {
    mapLayout.classList.remove("active");
  }

  if (detailContent) {
    detailContent.replaceChildren();
  }
}

// =========================================
// 14. 지역 필터
// =========================================

function applyFilter() {
  if (!map || !riskTools) return;

  closeDetailPanel();

  const items = districtSelect.value === "all"
    ? groupedAccidents
    : groupedAccidents.filter(
        item => item.districtCode === districtSelect.value
      );

  // 지역을 직접 변경했을 때만 지도 이동
  displayMarkers({
    fitBounds: items.length > 0,
    preserveDetail: false
  });
}

function resetFilter() {
  if (!districtSelect) return;

  districtSelect.value = "all";
  applyFilter();
}

// =========================================
// 15. 결과 한 건을 받을 때마다 반영
// =========================================

function acceptJobResult(job, result) {
  if (result.status === "success") {
    successfulRequests++;

    if (result.items.length) {
      allAccidents.push(...result.items);
    }
  } else if (result.status === "nodata") {
    noDataRequests.push({
      year: job.year,
      district: job.district,
      name: districtName(job.district),
      reason: "NODATA_ERROR"
    });
  } else {
    failedRequests.push({
      year: job.year,
      district: job.district,
      name: districtName(job.district),
      reason: result.reason || "UNKNOWN_ERROR"
    });
  }

  completedRequests++;

  // 새 사고지역이 들어오면 마커·위험도를 갱신
  if (
    result.status === "success" &&
    result.items.length > 0
  ) {
    scheduleUpdate();
  } else {
    updateStatus();
  }
}

// =========================================
// 16. 전체 데이터 실시간 수집
// =========================================

async function loadLiveData() {
  if (isLoading) return;

  isLoading = true;

  const jobs = [];

  for (const year of riskTools.RISK_YEARS) {
    for (const district of riskTools.RISK_DISTRICTS) {
      jobs.push({ year, district });
    }
  }

  totalRequests = jobs.length;

  let index = 0;

  async function worker() {
    while (index < jobs.length) {
      const job = jobs[index++];

      const result = await fetchWithRetry(
        job.year,
        job.district
      );

      acceptJobResult(job, result);
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
    isComplete = true;
    isLoading = false;

    // 마지막 데이터로 최종 위험도 계산
    scheduleUpdate(true);

    window.BIKE_SAFE_FAILED_REQUESTS =
      failedRequests;

    window.BIKE_SAFE_NODATA_REQUESTS =
      noDataRequests;

    console.group("BIKE SAFE 조회 결과");

    console.log(
      `총 ${totalRequests}건`,
      `정상 ${successfulRequests}건`,
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

// =========================================
// 17. 시작
// =========================================

window.addEventListener("load", async () => {
  if (
    !mapElement ||
    !districtSelect ||
    !statusBox
  ) {
    return;
  }

  if (!window.kakao || !kakao.maps) {
    statusBox.textContent =
      "카카오맵 SDK를 불러오지 못했어.";
    return;
  }

  try {
    riskTools = await import("./risk.js");
  } catch (error) {
    statusBox.textContent =
      "js/risk.js 파일을 확인해 줘.";
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

  if (
    !GAS_URL.startsWith(
      "https://script.google.com/macros/s/"
    ) ||
    !GAS_URL.endsWith("/exec")
  ) {
    statusBox.textContent =
      "GAS 웹 앱 URL을 확인해 줘.";
    return;
  }

  // 이전에 저장된 완전한 서울 기준이 있다면
  // 초기 마커부터 같은 기준을 사용
  riskReference =
    riskTools.readRiskReference();

  referenceIsPartial = !riskReference;
  updateLegend();

  // 데이터를 모두 기다리지 않고 수집 시작
  await loadLiveData();
});
