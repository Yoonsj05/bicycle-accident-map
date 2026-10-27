
/*
  BIKE SAFE - 사고 지도

  기능
  1. 2021~2023 서울 사고지역 조회
  2. 실패 시 자동 재시도
  3. 일부 실패해도 지도 표시
  4. 서울 전체 백분위 위험도 계산
  5. 사고지역 상세정보
  6. 요청 실패 원인 콘솔 출력
*/

// ====================================
// 1. 설정
// ====================================

// 기존에 사용하던 GAS /exec 주소 입력
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

const MAP_CENTER = {
  lat: 37.5665,
  lng: 126.9780
};

const REQUEST_TIMEOUT = 30000;
const MAX_RETRIES = 2;
const CACHE_TIME = 60 * 60 * 1000;

let map = null;
let riskTools = null;

let allAccidents = [];
let groupedAccidents = [];
let failedRequests = [];

let riskReference = null;
let referenceIsPartial = false;

let markers = [];
let requestCount = 0;
let isLoading = false;

const mapElement = document.getElementById("map");
const mapLayout = document.getElementById("mapLayout");
const detailPanel = document.getElementById("detailPanel");
const detailContent = document.getElementById("detailContent");
const districtSelect = document.getElementById("district");
const statusBox = document.getElementById("status");

// 기존 HTML의 onclick / onchange 연결
window.applyFilter = applyFilter;
window.resetFilter = resetFilter;
window.closeDetailPanel = closeDetailPanel;

// ====================================
// 2. 공통 함수
// ====================================

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatNumber(value) {
  return numberValue(value).toLocaleString("ko-KR");
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function districtName(code) {
  const option = Array.from(
    districtSelect.options
  ).find(item => item.value === code);

  return option ? option.textContent : code;
}

// ====================================
// 3. JSONP 요청
// ====================================

function requestJSONP(url) {
  return new Promise((resolve, reject) => {
    const callback =
      "bikeMapCallback_" + (++requestCount);

    const script = document.createElement("script");

    let finished = false;

    const timer = setTimeout(() => {
      finish(new Error("30초 응답 시간 초과"));
    }, REQUEST_TIMEOUT);

    function finish(error, data) {
      if (finished) return;

      finished = true;

      clearTimeout(timer);
      script.remove();

      if (error) {
        // 늦게 돌아온 JSONP 응답 보호
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
      finish(new Error("GAS 스크립트 연결 오류"));
    };

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" +
      encodeURIComponent(callback);

    document.body.appendChild(script);
  });
}

// ====================================
// 4. 캐시
// ====================================

function cacheKey(year, district) {
  return "bicycle_v3_" + year + "_" + district;
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
      Date.now() - saved.savedAt > CACHE_TIME
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
    console.warn("캐시 저장 실패", error);
  }
}

// ====================================
// 5. 개별 데이터 조회
// ====================================

async function fetchAccidents(year, district) {
  const cached = readCache(year, district);

  if (cached !== null) return cached;

  const url =
    GAS_URL +
    "?year=" + encodeURIComponent(year) +
    "&sido=11" +
    "&gugun=" + encodeURIComponent(district);

  const response = await requestJSONP(url);

  if (!response || response.success !== true) {
    throw new Error(
      response && (response.error || response.message)
        ? String(response.error || response.message)
        : "GAS 응답 success=false"
    );
  }

  if (!Array.isArray(response.accidents)) {
    throw new Error("사고지역 데이터 형식 오류");
  }

  const items = response.accidents.map(item => ({
    ...item,
    year: String(year),
    districtCode: String(district)
  }));

  saveCache(year, district, items);

  return items;
}

// ====================================
// 6. 자동 재시도
// ====================================

async function fetchWithRetry(year, district) {
  let lastError = null;

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      if (attempt > 0) {
        // 동시 재시도 집중을 줄이기 위한 지연
        await sleep(
          700 * attempt + Math.random() * 400
        );
      }

      return await fetchAccidents(year, district);

    } catch (error) {
      lastError = error;

      console.warn(
        `[지도] ${year}년 ${districtName(district)} ` +
        `${attempt + 1}번째 요청 실패:`,
        error.message
      );
    }
  }

  throw lastError;
}

// ====================================
// 7. 전체 서울 데이터 불러오기
// ====================================

async function loadAllAccidents() {
  if (isLoading) return false;

  isLoading = true;
  districtSelect.disabled = true;

  const jobs = [];

  for (const year of riskTools.RISK_YEARS) {
    for (const district of riskTools.RISK_DISTRICTS) {
      jobs.push({ year, district });
    }
  }

  const results = [];
  const failures = [];

  let index = 0;
  let completed = 0;

  async function worker() {
    while (index < jobs.length) {
      const job = jobs[index++];

      try {
        const items = await fetchWithRetry(
          job.year,
          job.district
        );

        results.push(...items);

      } catch (error) {
        failures.push({
          year: job.year,
          district: job.district,
          districtName: districtName(job.district),
          reason: error.message
        });
      }

      completed++;

      statusBox.textContent =
        `사고지역 조회 중 ${completed}/${jobs.length}`;
    }
  }

  try {
    // 동시 요청 2개로 축소
    await Promise.all([
      worker(),
      worker()
    ]);

    allAccidents = results;
    failedRequests = failures;

    // 실패 목록을 개발자 도구에서 확인 가능
    window.BIKE_SAFE_FAILED_REQUESTS = failures;

    console.group("BIKE SAFE 지도 요청 결과");
    console.log(
      `전체 ${jobs.length}건 중 ` +
      `${jobs.length - failures.length}건 성공`
    );

    if (failures.length > 0) {
      console.table(failures);
    }

    console.groupEnd();

    if (failures.length === jobs.length) {
      throw new Error("모든 데이터 요청에 실패했어.");
    }

    groupedAccidents =
      riskTools.groupRiskAccidents(allAccidents);

    // 일부 요청이 실패해도 화면에 표시할 위험도 계산
    if (failures.length === 0) {
      riskReference =
        riskTools.createRiskReference(groupedAccidents);

      referenceIsPartial = false;

      // 온전한 자료 기준만 저장
      riskTools.saveRiskReference(riskReference);

    } else {
      // 과거에 완전한 자료로 계산한 기준이 있다면
      // 그 기준을 우선 재사용
      const savedReference =
        riskTools.readRiskReference();

      if (savedReference) {
        riskReference = savedReference;
        referenceIsPartial = false;
      } else {
        // 없으면 현재 성공한 자료로 임시 기준 생성
        riskReference =
          riskTools.createRiskReference(groupedAccidents);

        referenceIsPartial = true;
      }
    }

    updateLegend();

    return true;

  } catch (error) {
    statusBox.textContent =
      "조회 오류: " + error.message;

    console.error(error);

    return false;

  } finally {
    isLoading = false;
    districtSelect.disabled = false;
  }
}

// ====================================
// 8. 위험도 범례 변경
// ====================================

function updateLegend() {
  const legend = document.querySelector(
    ".risk-legend-bar"
  );

  if (!legend || !riskReference) return;

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
    const label = segment.querySelector("span");

    if (label) {
      label.textContent = labels[index];
    }
  });

  const subtitle = legend.querySelector(
    ".legend-heading span"
  );

  if (subtitle) {
    subtitle.textContent = referenceIsPartial
      ? "부분 데이터 임시 기준"
      : "서울 전체 백분위 기준";
  }
}

// ====================================
// 9. 지도 마커
// ====================================

function clearMarkers() {
  markers.forEach(overlay => overlay.setMap(null));
  markers = [];
}

function displayMarkers(district = "all") {
  if (!map || !riskTools) return;

  clearMarkers();
  closeDetailPanel();

  const items = district === "all"
    ? groupedAccidents
    : groupedAccidents.filter(
        item => item.districtCode === district
      );

  const bounds = new kakao.maps.LatLngBounds();
  const positions = [];

  for (const item of items) {
    if (
      item.latitude === null ||
      item.longitude === null
    ) continue;

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
      "risk-marker " + (
        level === "unknown" ? "" : level
      );

    button.title =
      item.name + " · " +
      riskTools.getRiskLabel(
        item.riskScore,
        riskReference
      ) + " · " + item.riskScore + "점";

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
      showAccidentDetail(item);
      map.panTo(position);
    });

    overlay.setMap(map);
    markers.push(overlay);

    positions.push(position);
    bounds.extend(position);
  }

  if (positions.length === 1) {
    map.setCenter(positions[0]);
    map.setLevel(5);
  } else if (positions.length > 1) {
    map.setBounds(bounds, 50, 50, 70, 50);
  } else {
    map.setCenter(
      new kakao.maps.LatLng(
        MAP_CENTER.lat,
        MAP_CENTER.lng
      )
    );
    map.setLevel(9);
  }

  const region = district === "all"
    ? "서울 전체"
    : districtName(district);

  const failures = failedRequests.filter(
    item => district === "all" ||
      item.district === district
  );

  let message =
    `${region} · 사고다발지역 ` +
    `${positions.length}곳 표시`;

  if (failedRequests.length > 0) {
    message +=
      ` · 전체 요청 ${failedRequests.length}건 실패`;
  }

  if (failures.length > 0) {
    message += " · 현재 지역 일부 누락 가능";
  }

  if (referenceIsPartial) {
    message += " · 임시 위험도 기준";
  }

  statusBox.textContent = message;

  const totalAccidents = items.reduce(
    (sum, item) => sum + item.accidentCount,
    0
  );

  const totalCasualties = items.reduce(
    (sum, item) => sum + item.casualtyCount,
    0
  );

  setText("spotCount", formatNumber(items.length));
  setText(
    "accidentCount",
    formatNumber(totalAccidents)
  );
  setText(
    "casualtyCount",
    formatNumber(totalCasualties)
  );
  setText("currentRegion", region);
}

// ====================================
// 10. 상세정보
// ====================================

function createRow(label, value) {
  const row = document.createElement("div");
  row.className = "detail-row";

  const left = document.createElement("span");
  left.className = "detail-label";
  left.textContent = label;

  const right = document.createElement("span");
  right.className = "detail-value";
  right.textContent = value;

  row.append(left, right);
  return row;
}

function showAccidentDetail(item) {
  detailContent.replaceChildren();

  const name = document.createElement("h3");
  name.className = "region-name";
  name.textContent = item.name;

  detailContent.appendChild(name);

  const fields = [
    ["사고 건수", item.accidentCount, "건"],
    ["사상자 수", item.casualtyCount, "명"],
    ["사망자 수", item.deathCount, "명"],
    ["중상자 수", item.seriousCount, "명"],
    ["경상자 수", item.minorCount, "명"],
    [
      "부상신고자",
      item.reportedInjuryCount,
      "명"
    ]
  ];

  fields.forEach(([label, value, unit]) => {
    detailContent.appendChild(
      createRow(
        label,
        formatNumber(value) + unit
      )
    );
  });

  const heading = document.createElement("h4");
  heading.className = "year-heading";
  heading.textContent = "연도별 사고 현황";

  detailContent.appendChild(heading);

  const table = document.createElement("table");
  table.className = "year-table";

  const thead = document.createElement("thead");
  const header = document.createElement("tr");

  ["연도", "사고", "사상자"].forEach(text => {
    const th = document.createElement("th");
    th.textContent = text;
    header.appendChild(th);
  });

  thead.appendChild(header);
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
            formatNumber(record.accidentCount) + "건",
            formatNumber(record.casualtyCount) + "명"
          ]
        : [year, "기록 없음", "-"];

    const row = document.createElement("tr");

    values.forEach(value => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  detailContent.appendChild(table);

  const total = createRow(
    "확인된 3개 연도 합계",
    formatNumber(item.accidentCount) + "건"
  );

  detailContent.appendChild(total);

  const scoreBox = document.createElement("div");
  scoreBox.className = "score-box";

  const label = document.createElement("div");
  label.textContent =
    riskTools.getRiskLabel(
      item.riskScore,
      riskReference
    ) + " · 상대적 위험도";

  const score = document.createElement("strong");
  score.className = "score-number";
  score.textContent =
    formatNumber(item.riskScore) + "점";

  scoreBox.append(label, score);
  detailContent.appendChild(scoreBox);

  const notice = document.createElement("p");
  notice.className = "score-caption";

  notice.textContent = referenceIsPartial
    ? "일부 요청 실패 · 확인된 자료 기준 임시 등급"
    : "서울 전체 비교 기준 · 공식 위험등급 아님";

  detailContent.appendChild(notice);

  detailPanel.scrollTop = 0;
  mapLayout.classList.add("active");
}

function closeDetailPanel() {
  if (mapLayout) {
    mapLayout.classList.remove("active");
  }

  if (detailContent) {
    detailContent.replaceChildren();
  }
}

// ====================================
// 11. 지역 선택
// ====================================

function applyFilter() {
  if (isLoading || !map) return;

  displayMarkers(districtSelect.value);
}

function resetFilter() {
  if (isLoading || !map) return;

  districtSelect.value = "all";
  displayMarkers("all");
}

// ====================================
// 12. 실행
// ====================================

window.addEventListener("load", async () => {
  if (!mapElement || !districtSelect || !statusBox) {
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
      "js/risk.js 파일을 불러오지 못했어.";

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
      "GAS 웹 앱 주소가 설정되지 않았어.";
    return;
  }

  const success = await loadAllAccidents();

  if (success) {
    displayMarkers("all");
  }
});
