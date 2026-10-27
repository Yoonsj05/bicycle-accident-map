
/*
  BIKE SAFE - 지도 기능
  2021~2023 통합 사고다발지역
  공공데이터 GAS 연결 / 카카오맵
*/

// =====================================
// 1. 설정
// =====================================

// 기존 GAS 웹 앱 주소로 변경
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

const YEARS = ["2021", "2022", "2023"];

const DISTRICTS = [
  "680", "740", "305", "500", "620",
  "215", "530", "545", "350", "320",
  "230", "590", "440", "410", "650",
  "200", "290", "710", "470", "560",
  "170", "380", "110", "140", "260"
];

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

let requestCounter = 0;
let loading = false;

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

// =====================================
// 2. 유틸리티
// =====================================

function numberValue(value) {
  return Number(value) || 0;
}

function formatNumber(value) {
  return numberValue(value).toLocaleString("ko-KR");
}

function setText(id, text) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = text;
  }
}

// =====================================
// 3. GAS JSONP 요청
// =====================================

function requestJSONP(url) {

  return new Promise(function(resolve, reject) {

    const callbackName =
      "bikeMapCallback" + (++requestCounter);

    const script = document.createElement("script");

    let finished = false;

    const timer = setTimeout(function() {
      finish(new Error("요청 시간 초과"));
    }, 30000);

    function finish(error, data) {

      if (finished) return;
      finished = true;

      clearTimeout(timer);
      script.remove();

      if (error) {

        // 늦은 JSONP 응답에 대비
        window[callbackName] = function() {};

        reject(error);

      } else {

        delete window[callbackName];
        resolve(data);
      }
    }

    window[callbackName] = function(data) {
      finish(null, data);
    };

    script.onerror = function() {
      finish(new Error("GAS 연결 실패"));
    };

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" +
      encodeURIComponent(callbackName);

    document.body.appendChild(script);
  });
}

// =====================================
// 4. 조회 결과 캐시
// =====================================

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
        items: items
      })
    );

  } catch (error) {
    console.warn("지도 캐시 저장 생략");
  }
}

// =====================================
// 5. 개별 API 조회
// =====================================

async function fetchAccidents(year, district) {

  const cached = readCache(year, district);

  if (cached !== null) {
    return cached;
  }

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
        : "사고 데이터 조회 오류"
    );
  }

  const raw = Array.isArray(data.accidents)
    ? data.accidents
    : [];

  const items = raw.map(function(item) {
    return {
      ...item,
      year: year,
      districtCode: district
    };
  });

  saveCache(year, district, items);

  return items;
}

// =====================================
// 6. 전체 데이터 불러오기
// =====================================

async function loadAllAccidents() {

  if (loading) return false;

  if (
    !GAS_URL.startsWith(
      "https://script.google.com/macros/s/"
    ) ||
    !GAS_URL.endsWith("/exec")
  ) {
    statusBox.textContent =
      "js/map.js에 GAS 웹 앱 주소를 입력해 줘.";
    return false;
  }

  loading = true;
  districtSelect.disabled = true;

  const jobs = [];

  YEARS.forEach(function(year) {

    DISTRICTS.forEach(function(district) {

      jobs.push({
        year: year,
        district: district
      });

    });
  });

  const results = [];
  const failures = [];

  let nextIndex = 0;
  let completed = 0;

  async function worker() {

    while (nextIndex < jobs.length) {

      const job = jobs[nextIndex++];

      try {

        const items = await fetchAccidents(
          job.year,
          job.district
        );

        results.push(...items);

      } catch (error) {

        failures.push(job);

        console.error(
          "조회 실패:",
          job.year,
          job.district,
          error
        );
      }

      completed++;

      statusBox.textContent =
        "데이터 조회 중 " +
        completed + " / " + jobs.length;
    }
  }

  try {

    await Promise.all([
      worker(),
      worker(),
      worker()
    ]);

    if (failures.length === jobs.length) {
      throw new Error(
        "모든 사고 데이터 요청에 실패했어."
      );
    }

    allAccidents = results;
    failedRequests = failures;

    groupAccidentRecords();

    return true;

  } catch (error) {

    statusBox.textContent =
      "데이터 조회 실패: " + error.message;

    return false;

  } finally {

    loading = false;
    districtSelect.disabled = false;
  }
}

// =====================================
// 7. 같은 이름의 사고지역 통합
// =====================================

function groupAccidentRecords() {

  const groups = new Map();

  allAccidents.forEach(function(item) {

    const name = String(item.name || "").trim();
    const normalizedName = name.replace(/\s+/g, "");

    if (!normalizedName) return;

    const key =
      item.districtCode + "|" + normalizedName;

    if (!groups.has(key)) {

      groups.set(key, {

        name: name,
        districtCode: item.districtCode,

        latitude: null,
        longitude: null,

        accidentCount: 0,
        casualtyCount: 0,
        deathCount: 0,
        seriousCount: 0,
        minorCount: 0,
        reportedInjuryCount: 0,
        riskScore: 0,

        records: {}
      });
    }

    const group = groups.get(key);

    if (!group.records[item.year]) {

      group.records[item.year] = {

        accidentCount: 0,
        casualtyCount: 0,
        deathCount: 0,
        seriousCount: 0,
        minorCount: 0,
        reportedInjuryCount: 0,
        riskScore: 0
      };
    }

    const fields = [
      "accidentCount",
      "casualtyCount",
      "deathCount",
      "seriousCount",
      "minorCount",
      "reportedInjuryCount",
      "riskScore"
    ];

    fields.forEach(function(field) {

      const value = numberValue(item[field]);

      group[field] += value;
      group.records[item.year][field] += value;
    });

    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);

    if (
      item.latitude != null &&
      item.longitude != null &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= 33 &&
      latitude <= 39 &&
      longitude >= 124 &&
      longitude <= 132
    ) {
      group.latitude = latitude;
      group.longitude = longitude;
    }
  });

  groupedAccidents = Array.from(groups.values());
}

// =====================================
// 8. 마커 위험도 색상
// =====================================

function getRiskLevel(score) {

  if (score >= 71) return "high";
  if (score >= 31) return "medium";

  return "low";
}

// =====================================
// 9. 기존 마커 제거
// =====================================

function clearMarkers() {

  mapMarkers.forEach(function(overlay) {
    overlay.setMap(null);
  });

  mapMarkers = [];
}

// =====================================
// 10. 지도 업데이트
// =====================================

function displayMarkers(district) {

  if (!map) return;

  clearMarkers();
  closeDetailPanel();

  const items = district === "all"
    ? groupedAccidents
    : groupedAccidents.filter(function(item) {
        return item.districtCode === district;
      });

  const bounds = new kakao.maps.LatLngBounds();
  const positions = [];

  items.forEach(function(item) {

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

    const button = document.createElement("button");

    button.type = "button";
    button.className =
      "risk-marker " +
      getRiskLevel(item.riskScore);

    button.title =
      item.name + " · 위험도 " +
      item.riskScore + "점";

    button.setAttribute(
      "aria-label",
      button.title
    );

    const overlay = new kakao.maps.CustomOverlay({
      position: position,
      content: button,
      yAnchor: 0.5,
      zIndex: 3
    });

    button.addEventListener("click", function() {

      showAccidentDetail(item);

      // 패널은 지도 위에 열리므로
      // 지도 크기를 다시 계산할 필요가 없음
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

    map.setBounds(bounds, 50, 50, 75, 50);

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
    "currentRegion",
    "현재 표시: " + name + " · 2021~2023년"
  );

  setText("spotCount", formatNumber(items.length));

  setText(
    "accidentCount",
    formatNumber(
      items.reduce(function(sum, item) {
        return sum + item.accidentCount;
      }, 0)
    )
  );

  setText(
    "casualtyCount",
    formatNumber(
      items.reduce(function(sum, item) {
        return sum + item.casualtyCount;
      }, 0)
    )
  );

  const failures = failedRequests.filter(
    function(job) {
      return district === "all" ||
        job.district === district;
    }
  );

  let message =
    name + " · 사고다발지역 " +
    positions.length + "곳 표시";

  if (!positions.length) {
    message =
      name + "에서 조회된 사고다발지역이 없어.";
  }

  if (failures.length) {
    message +=
      " · " + failures.length +
      "개 요청 실패로 일부 누락 가능";
  }

  statusBox.textContent = message;
}

// =====================================
// 11. 상세정보 행 만들기
// =====================================

function createDetailRow(label, value) {

  const row = document.createElement("div");
  row.className = "detail-row";

  const left = document.createElement("span");
  left.className = "detail-label";
  left.textContent = label;

  const right = document.createElement("span");
  right.className = "detail-value";
  right.textContent = value;

  row.appendChild(left);
  row.appendChild(right);

  return row;
}

// =====================================
// 12. 연도별 표
// =====================================

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
    function(label) {

      const th = document.createElement("th");
      th.textContent = label;
      headerRow.appendChild(th);
    }
  );

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  YEARS.forEach(function(year) {

    const record = item.records[year];

    const failed = failedRequests.some(
      function(job) {
        return job.year === year &&
          job.district === item.districtCode;
      }
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

    values.forEach(function(value) {

      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  const total = document.createElement("tr");

  [
    "확인 합계",
    formatNumber(item.accidentCount) + "건",
    formatNumber(item.casualtyCount) + "명"
  ].forEach(function(value) {

    const td = document.createElement("td");
    td.textContent = value;
    total.appendChild(td);
  });

  tfoot.appendChild(total);
  table.appendChild(tfoot);

  detailContent.appendChild(table);

  const note = document.createElement("p");
  note.className = "year-note";
  note.textContent =
    "기록 없음은 실제 사고 0건이 아니라 " +
    "해당 연도에 사고다발지역으로 " +
    "조회되지 않았다는 의미야.";

  detailContent.appendChild(note);
}

// =====================================
// 13. 사고 상세정보 열기
// =====================================

function showAccidentDetail(item) {

  if (!detailContent) return;

  detailContent.replaceChildren();

  const name = document.createElement("h3");
  name.className = "region-name";
  name.textContent = item.name;

  detailContent.appendChild(name);

  const fields = [
    ["확인된 사고 건수", item.accidentCount, "건"],
    ["확인된 사상자 수", item.casualtyCount, "명"],
    ["사망자 수", item.deathCount, "명"],
    ["중상자 수", item.seriousCount, "명"],
    ["경상자 수", item.minorCount, "명"],
    [
      "부상신고자 수",
      item.reportedInjuryCount,
      "명"
    ]
  ];

  fields.forEach(function(field) {

    detailContent.appendChild(
      createDetailRow(
        field[0],
        formatNumber(field[1]) + field[2]
      )
    );
  });

  createYearTable(item);

  const scoreBox = document.createElement("div");
  scoreBox.className = "score-box";

  const title = document.createElement("div");
  title.textContent = "위험도 점수 합계";

  const score = document.createElement("strong");
  score.className = "score-number";
  score.textContent = item.riskScore + "점";

  scoreBox.appendChild(title);
  scoreBox.appendChild(score);

  detailContent.appendChild(scoreBox);

  const caption = document.createElement("p");
  caption.className = "score-caption";
  caption.textContent =
    "프로젝트 자체 분석 점수 · 공식 위험등급 아님";

  detailContent.appendChild(caption);

  detailPanel.scrollTop = 0;
  mapLayout.classList.add("active");
}

// =====================================
// 14. 상세정보 닫기
// =====================================

function closeDetailPanel() {

  if (mapLayout) {
    mapLayout.classList.remove("active");
  }

  if (detailContent) {
    detailContent.replaceChildren();
  }
}

// =====================================
// 15. 지역 선택 필터
// =====================================

function applyFilter() {

  if (loading || !map) return;

  displayMarkers(districtSelect.value);
}

function resetFilter() {

  if (loading || !map) return;

  districtSelect.value = "all";
  displayMarkers("all");
}

// =====================================
// 16. 페이지 시작
// =====================================

window.addEventListener("load", async function() {

  if (!mapElement || !districtSelect) return;

  if (!window.kakao || !kakao.maps) {
    statusBox.textContent =
      "카카오맵 연결 실패. " +
      "JavaScript 키와 등록 도메인을 확인해 줘.";
    return;
  }

  map = new kakao.maps.Map(mapElement, {

    center: new kakao.maps.LatLng(
      CENTER.latitude,
      CENTER.longitude
    ),

    level: 9
  });

  const success = await loadAllAccidents();

  if (success) {
    displayMarkers("all");
  }
});
