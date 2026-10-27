const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

const CENTER = {
  latitude: 37.5665,
  longitude: 126.9780
};

const CACHE_TIME = 60 * 60 * 1000;

let map = null;
let mapMarkers = [];
let allAccidents = [];
let groupedAccidents = [];
let failedRequests = [];
let riskReference = null;
let riskTools = null;
let requestCounter = 0;
let loading = false;

const mapElement = document.getElementById("map");
const mapLayout = document.getElementById("mapLayout");
const detailPanel = document.getElementById("detailPanel");
const detailContent = document.getElementById("detailContent");
const districtSelect = document.getElementById("district");
const statusBox = document.getElementById("status");

// 기존 HTML의 onchange / onclick에서 사용
window.applyFilter = applyFilter;
window.resetFilter = resetFilter;
window.closeDetailPanel = closeDetailPanel;

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function formatNumber(value) {
  return (Number(value) || 0).toLocaleString("ko-KR");
}

function requestJSONP(url) {
  return new Promise((resolve, reject) => {
    const callback =
      "bikeMapCallback" + (++requestCounter);

    const script = document.createElement("script");
    let completed = false;

    const timer = setTimeout(() => {
      finish(new Error("요청 시간 초과"));
    }, 30000);

    function finish(error, data) {
      if (completed) return;
      completed = true;

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
    script.onerror = () =>
      finish(new Error("GAS 연결 실패"));

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" + encodeURIComponent(callback);

    document.body.appendChild(script);
  });
}

function cacheKey(year, district) {
  return "bicycle_v3_" + year + "_" + district;
}

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
      Date.now() - saved.savedAt > CACHE_TIME
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

async function fetchAccidents(year, district) {
  const cached = readCache(year, district);
  if (cached !== null) return cached;

  const url =
    GAS_URL +
    "?year=" + encodeURIComponent(year) +
    "&sido=11" +
    "&gugun=" + encodeURIComponent(district);

  const data = await requestJSONP(url);

  if (!data || data.success !== true) {
    throw new Error(
      data && data.error
        ? data.error
        : "데이터 조회 실패"
    );
  }

  const raw = Array.isArray(data.accidents)
    ? data.accidents
    : [];

  const items = raw.map(item => ({
    ...item,
    year,
    districtCode: district
  }));

  saveCache(year, district, items);
  return items;
}

async function loadAllAccidents() {
  if (loading) return false;

  if (
    !GAS_URL.startsWith("https://script.google.com/macros/s/") ||
    !GAS_URL.endsWith("/exec")
  ) {
    statusBox.textContent =
      "js/map.js의 GAS 웹 앱 URL을 확인해 줘.";
    return false;
  }

  loading = true;
  districtSelect.disabled = true;

  const jobs = [];

  riskTools.RISK_YEARS.forEach(year => {
    riskTools.RISK_DISTRICTS.forEach(district => {
      jobs.push({ year, district });
    });
  });

  const results = [];
  const failures = [];

  let index = 0;
  let completed = 0;

  async function worker() {
    while (index < jobs.length) {
      const job = jobs[index++];

      try {
        const items = await fetchAccidents(
          job.year,
          job.district
        );
        results.push(...items);
      } catch (error) {
        failures.push(job);
        console.error("조회 실패", job, error);
      }

      completed++;
      statusBox.textContent =
        `사고지역 조회 중 ${completed}/${jobs.length}`;
    }
  }

  try {
    await Promise.all([
      worker(), worker(), worker()
    ]);

    if (failures.length === jobs.length) {
      throw new Error("모든 데이터 조회에 실패했어.");
    }

    allAccidents = results;
    failedRequests = failures;

    groupedAccidents =
      riskTools.groupRiskAccidents(allAccidents);

    if (failures.length === 0) {
      // 전 지역·전 연도 조회 성공일 때만 기준 계산
      riskReference =
        riskTools.createRiskReference(groupedAccidents);

      riskTools.saveRiskReference(riskReference);
    } else {
      // 불완전한 자료로 새 기준을 계산하지 않음
      riskReference = riskTools.readRiskReference();
    }

    updateLegend();

    return true;

  } catch (error) {
    statusBox.textContent = error.message;
    return false;
  } finally {
    loading = false;
    districtSelect.disabled = false;
  }
}

function getRiskLevel(score) {
  return riskTools.getRiskLevel(score, riskReference);
}

function clearMarkers() {
  mapMarkers.forEach(overlay => {
    overlay.setMap(null);
  });
  mapMarkers = [];
}

function updateLegend() {
  const legend = document.querySelector(
    ".risk-legend-bar"
  );

  if (!legend) return;

  const ranges = riskTools.getRiskRanges(
    riskReference
  );

  const segments = legend.querySelectorAll(
    ".legend-segment"
  );

  const labels = [
    "주의 · " + ranges.low,
    "높음 · " + ranges.medium,
    "매우 높음 · " + ranges.high
  ];

  segments.forEach((segment, index) => {
    const label =
      segment.querySelector("span");

    if (label) label.textContent = labels[index];
  });

  const subtitle = legend.querySelector(
    ".legend-heading span"
  );

  if (subtitle) {
    subtitle.textContent = riskReference
      ? "서울 전체 백분위 기준"
      : "전체 자료 조회 필요";
  }
}

function displayMarkers(district) {
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

  items.forEach(item => {
    if (
      item.latitude == null ||
      item.longitude == null
    ) return;

    const position = new kakao.maps.LatLng(
      item.latitude,
      item.longitude
    );

    const button = document.createElement("button");
    button.type = "button";

    const level = getRiskLevel(item.riskScore);

    button.className =
      "risk-marker " +
      (level === "unknown" ? "" : level);

    // 기준 계산 불가일 때는 중립색
    if (level === "unknown") {
      button.style.backgroundColor = "#94a3b8";
    }

    button.title =
      item.name + " · " +
      riskTools.getRiskLabel(
        item.riskScore,
        riskReference
      );

    button.setAttribute("aria-label", button.title);

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
    mapMarkers.push(overlay);
    positions.push(position);
    bounds.extend(position);
  });

  if (positions.length === 1) {
    map.setCenter(positions[0]);
    map.setLevel(5);
  } else if (positions.length > 1) {
    map.setBounds(bounds, 50, 50, 70, 50);
  } else {
    map.setCenter(
      new kakao.maps.LatLng(
        CENTER.latitude,
        CENTER.longitude
      )
    );
    map.setLevel(9);
  }

  const name = district === "all"
    ? "서울 전체"
    : districtSelect.options[
        districtSelect.selectedIndex
      ].text;

  setText(
    "spotCount",
    formatNumber(items.length)
  );

  setText(
    "accidentCount",
    formatNumber(
      items.reduce(
        (sum, item) => sum + item.accidentCount,
        0
      )
    )
  );

  setText(
    "casualtyCount",
    formatNumber(
      items.reduce(
        (sum, item) => sum + item.casualtyCount,
        0
      )
    )
  );

  setText(
    "currentRegion",
    `${name} · 2021~2023년`
  );

  const missing = failedRequests.filter(
    job => district === "all" ||
      job.district === district
  );

  let message =
    `${name} · 사고다발지역 ${positions.length}곳`;

  if (missing.length > 0) {
    message +=
      ` · 요청 ${missing.length}건 실패`;
  }

  if (!riskReference) {
    message +=
      " · 서울 전체 위험도 기준 미확정";
  }

  statusBox.textContent = message;
}

function createDetailRow(label, value) {
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

function createYearTable(item) {
  const heading = document.createElement("h4");
  heading.className = "year-heading";
  heading.textContent = "연도별 사고 현황";
  detailContent.appendChild(heading);

  const table = document.createElement("table");
  table.className = "year-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  ["연도", "사고 건수", "사상자 수"].forEach(
    label => {
      const th = document.createElement("th");
      th.textContent = label;
      headerRow.appendChild(th);
    }
  );

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  riskTools.RISK_YEARS.forEach(year => {
    const record = item.records[year];

    const failed = failedRequests.some(
      job => job.year === year &&
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

    const tr = document.createElement("tr");

    values.forEach(value => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  const totalRow = document.createElement("tr");

  [
    "확인 합계",
    formatNumber(item.accidentCount) + "건",
    formatNumber(item.casualtyCount) + "명"
  ].forEach(value => {
    const td = document.createElement("td");
    td.textContent = value;
    totalRow.appendChild(td);
  });

  tfoot.appendChild(totalRow);
  table.appendChild(tfoot);
  detailContent.appendChild(table);

  const note = document.createElement("p");
  note.className = "year-note";
  note.textContent =
    "기록 없음은 실제 사고 0건을 의미하지 않아.";
  detailContent.appendChild(note);
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
    ["부상신고자", item.reportedInjuryCount, "명"]
  ];

  fields.forEach(([label, value, unit]) => {
    detailContent.appendChild(
      createDetailRow(
        label,
        formatNumber(value) + unit
      )
    );
  });

  createYearTable(item);

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
  score.textContent =
    formatNumber(item.riskScore) + "점";

  scoreBox.append(scoreLabel, score);
  detailContent.appendChild(scoreBox);

  const note = document.createElement("p");
  note.className = "score-caption";
  note.textContent =
    "서울 전체 사고다발지역 비교 기준 · " +
    "공식 위험등급 아님";
  detailContent.appendChild(note);

  detailPanel.scrollTop = 0;
  mapLayout.classList.add("active");
}

function closeDetailPanel() {
  mapLayout.classList.remove("active");
  detailContent.replaceChildren();
}

function applyFilter() {
  if (loading || !map) return;
  displayMarkers(districtSelect.value);
}

function resetFilter() {
  if (loading || !map) return;
  districtSelect.value = "all";
  displayMarkers("all");
}

window.addEventListener("load", async () => {
  if (!window.kakao || !kakao.maps) {
    statusBox.textContent =
      "카카오맵 SDK를 확인해 줘.";
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
      CENTER.latitude,
      CENTER.longitude
    ),
    level: 9
  });

  riskReference = riskTools.readRiskReference();
  updateLegend();

  const success = await loadAllAccidents();

  if (success) {
    displayMarkers("all");
  }
});
