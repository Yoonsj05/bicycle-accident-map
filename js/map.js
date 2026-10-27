
/*
  BIKE SAFE - 메인 지도
  2021~2023년 통합
  지역 필터 / 위험도 마커 / 통계 / TOP 5
*/

// =====================================
// 1. 설정
// =====================================

// 기존 Google Apps Script 웹 앱 URL로 변경
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

let callbackNumber = 0;
let loading = false;

const districtSelect =
  document.getElementById("district");

const statusBox =
  document.getElementById("status");

const mapLayout =
  document.getElementById("mapLayout");

const detailContent =
  document.getElementById("detailContent");

const rankingContent =
  document.getElementById("mapRankingContent");

const filterButton =
  document.getElementById("filterButton");

const resetButton =
  document.getElementById("resetButton");

// =====================================
// 2. 안전한 문자열 표시
// =====================================

function setText(id, value) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = value;
  }
}

function numberValue(value) {
  return Number(value) || 0;
}

function formatNumber(value) {
  return numberValue(value).toLocaleString("ko-KR");
}

// =====================================
// 3. JSONP로 GAS 호출
// =====================================

function requestJSONP(url) {
  return new Promise(function(resolve, reject) {

    const callback =
      "bikeSafeCallback" + (++callbackNumber);

    const script = document.createElement("script");

    let finished = false;

    const timer = setTimeout(function() {
      finish(new Error("응답 시간 초과"));
    }, 30000);

    function finish(error, result) {
      if (finished) return;

      finished = true;
      clearTimeout(timer);
      script.remove();

      if (error) {
        // 늦게 도착한 응답이 있더라도 오류 방지
        window[callback] = function() {};
        reject(error);
      } else {
        delete window[callback];
        resolve(result);
      }
    }

    window[callback] = function(result) {
      finish(null, result);
    };

    script.onerror = function() {
      finish(new Error("GAS 연결 실패"));
    };

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" +
      encodeURIComponent(callback);

    document.body.appendChild(script);
  });
}

// =====================================
// 4. 브라우저 캐시
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
    console.log("캐시 저장 생략");
  }
}

// =====================================
// 5. 개별 지역 데이터 조회
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

  const response = await requestJSONP(url);

  if (!response || !response.success) {
    throw new Error(
      response && response.error
        ? response.error
        : "데이터 조회 오류"
    );
  }

  const items = Array.isArray(response.accidents)
    ? response.accidents
    : [];

  const normalized = items.map(function(item) {
    return {
      ...item,
      year: year,
      districtCode: district
    };
  });

  saveCache(year, district, normalized);

  return normalized;
}

// =====================================
// 6. 3개 연도 · 서울 25개 자치구 조회
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
      "js/map.js의 GAS URL을 확인해 주세요.";
    return false;
  }

  loading = true;

  if (filterButton) filterButton.disabled = true;
  if (resetButton) resetButton.disabled = true;
  districtSelect.disabled = true;

  const jobs = [];

  YEARS.forEach(function(year) {
    DISTRICTS.forEach(function(district) {
      jobs.push({ year, district });
    });
  });

  let nextJob = 0;
  let completed = 0;

  const results = [];
  const failures = [];

  async function worker() {
    while (nextJob < jobs.length) {

      const job = jobs[nextJob++];

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
        "사고 데이터 조회 중 " +
        completed + " / " + jobs.length;
    }
  }

  try {

    // 동시에 최대 3건 조회
    await Promise.all([
      worker(),
      worker(),
      worker()
    ]);

    if (failures.length === jobs.length) {
      throw new Error("모든 데이터 조회에 실패했어요.");
    }

    allAccidents = results;
    failedRequests = failures;

    groupAccidentRecords();

    return true;

  } catch (error) {

    statusBox.textContent =
      "데이터 오류: " + error.message;

    rankingContent.textContent =
      "사고지역 데이터를 표시할 수 없어요.";

    return false;

  } finally {
    loading = false;
    districtSelect.disabled = false;

    if (filterButton) filterButton.disabled = false;
    if (resetButton) resetButton.disabled = false;
  }
}

// =====================================
// 7. 연도별 동일 사고지역 묶기
// =====================================

function groupAccidentRecords() {

  const groups = new Map();

  allAccidents.forEach(function(item) {

    const name = String(item.name || "").trim();

    const normalizedName =
      name.replace(/\s+/g, "");

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
      latitude >= 33 && latitude <= 39 &&
      longitude >= 124 && longitude <= 132
    ) {
      group.latitude = latitude;
      group.longitude = longitude;
    }
  });

  groupedAccidents = Array.from(groups.values());
}

// =====================================
// 8. 위험도 색상
// =====================================

function getRiskLevel(score) {

  if (score >= 71) {
    return "high";
  }

  if (score >= 31) {
    return "medium";
  }

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
// 10. 통계 카드 업데이트
// =====================================

function updateStatistics(items) {

  const totalAccidents = items.reduce(
    function(sum, item) {
      return sum + item.accidentCount;
    }, 0
  );

  const totalCasualties = items.reduce(
    function(sum, item) {
      return sum + item.casualtyCount;
    }, 0
  );

  setText(
    "spotCount",
    formatNumber(items.length)
  );

  setText(
    "accidentCount",
    formatNumber(totalAccidents)
  );

  setText(
    "casualtyCount",
    formatNumber(totalCasualties)
  );
}

// =====================================
// 11. 지도 위 TOP 5
// =====================================

function updateRanking(items) {

  rankingContent.replaceChildren();

  const topFive = [...items]
    .sort(function(a, b) {
      return b.riskScore - a.riskScore;
    })
    .slice(0, 5);

  if (topFive.length === 0) {
    rankingContent.textContent =
      "조회된 사고다발지역이 없어요.";
    return;
  }

  const maxScore = Math.max(
    1,
    ...topFive.map(function(item) {
      return item.riskScore;
    })
  );

  topFive.forEach(function(item, index) {

    const row = document.createElement("div");
    row.className = "rank-row";

    const position = document.createElement("span");
    position.className = "rank-position";
    position.textContent = index + 1;

    const name = document.createElement("span");
    name.className = "rank-name";
    name.textContent = item.name;
    name.title = item.name;

    const track = document.createElement("div");
    track.className = "rank-track";

    const fill = document.createElement("div");
    fill.className = "rank-fill";

    fill.style.width =
      (item.riskScore / maxScore * 100) + "%";

    track.appendChild(fill);

    const score = document.createElement("span");
    score.className = "rank-score";
    score.textContent = item.riskScore + "점";

    row.appendChild(position);
    row.appendChild(name);
    row.appendChild(track);
    row.appendChild(score);

    rankingContent.appendChild(row);
  });
}

// =====================================
// 12. 지도 마커 표시
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

  updateStatistics(items);
  updateRanking(items);

  const bounds = new kakao.maps.LatLngBounds();

  let validCount = 0;

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

    // 위험도 색깔 원형 마커
    const markerElement =
      document.createElement("button");

    markerElement.type = "button";
    markerElement.className =
      "risk-marker " +
      getRiskLevel(item.riskScore);

    markerElement.title =
      item.name +
      " · 위험도 " +
      item.riskScore + "점";

    markerElement.setAttribute(
      "aria-label",
      markerElement.title
    );

    const overlay = new kakao.maps.CustomOverlay({
      position: position,
      content: markerElement,
      yAnchor: 0.5,
      zIndex: 3
    });

    markerElement.addEventListener(
      "click",
      function() {
        showAccidentDetail(item);
        map.panTo(position);
      }
    );

    overlay.setMap(map);
    mapMarkers.push(overlay);

    bounds.extend(position);
    validCount++;
  });

  if (validCount === 1) {
    const firstItem = items.find(function(item) {
      return item.latitude != null &&
        item.longitude != null;
    });

    if (firstItem) {
      map.setCenter(
        new kakao.maps.LatLng(
          firstItem.latitude,
          firstItem.longitude
        )
      );
      map.setLevel(5);
    }

  } else if (validCount > 1) {

    map.setBounds(bounds, 50, 50, 50, 50);

  } else {

    // 마커가 없는 경우 기본 서울 위치
    map.setCenter(
      new kakao.maps.LatLng(
        CENTER.latitude,
        CENTER.longitude
      )
    );
    map.setLevel(9);
  }

  const regionName = district === "all"
    ? "서울 전체"
    : districtSelect.options[
        districtSelect.selectedIndex
      ].text;

  setText(
    "currentRegion",
    "현재 표시: " +
    regionName +
    " · 2021~2023년"
  );

  const missing = failedRequests.filter(
    function(job) {
      return district === "all" ||
        job.district === district;
    }
  );

  let message =
    regionName +
    " · 사고다발지역 " +
    validCount + "곳 표시";

  if (validCount === 0) {
    message =
      regionName +
      "에서 조회된 사고다발지역이 없어요.";
  }

  if (missing.length > 0) {
    message +=
      " / " + missing.length +
      "개 요청 실패로 일부 누락 가능";
  }

  statusBox.textContent = message;
}

// =====================================
// 13. 연도별 표 만들기
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

  ["연도", "사고 건수", "사상자"].forEach(
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

    const tr = document.createElement("tr");
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
    "기록 없음은 사고 0건이 아니라 " +
    "해당 연도 사고다발지역으로 " +
    "조회되지 않았다는 의미예요.";

  detailContent.appendChild(note);
}

// =====================================
// 14. 상세정보 행
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
// 15. 상세정보 열기
// =====================================

function showAccidentDetail(item) {

  detailContent.replaceChildren();

  const name = document.createElement("h4");
  name.className = "region-name";
  name.textContent = item.name;

  detailContent.appendChild(name);

  detailContent.appendChild(
    createDetailRow(
      "사고 건수",
      formatNumber(item.accidentCount) + "건"
    )
  );

  detailContent.appendChild(
    createDetailRow(
      "사상자 수",
      formatNumber(item.casualtyCount) + "명"
    )
  );

  detailContent.appendChild(
    createDetailRow(
      "사망자 수",
      formatNumber(item.deathCount) + "명"
    )
  );

  detailContent.appendChild(
    createDetailRow(
      "중상자 수",
      formatNumber(item.seriousCount) + "명"
    )
  );

  detailContent.appendChild(
    createDetailRow(
      "경상자 수",
      formatNumber(item.minorCount) + "명"
    )
  );

  createYearTable(item);

  const scoreBox = document.createElement("div");
  scoreBox.className = "score-box";

  const label = document.createElement("div");
  label.textContent =
    "확인된 기록의 위험도 점수 합계";

  const score = document.createElement("strong");
  score.className = "score-number";
  score.textContent = item.riskScore + "점";

  scoreBox.appendChild(label);
  scoreBox.appendChild(score);
  detailContent.appendChild(scoreBox);

  const caption = document.createElement("p");
  caption.className = "score-caption";
  caption.textContent =
    "프로젝트 자체 분석 점수이며 " +
    "공식 위험등급은 아니에요.";

  detailContent.appendChild(caption);

  mapLayout.classList.add("active");
}

// =====================================
// 16. 상세정보 닫기
// =====================================

function closeDetailPanel() {

  mapLayout.classList.remove("active");

  if (detailContent) {
    detailContent.replaceChildren();
  }
}

// =====================================
// 17. 필터 및 전체 보기
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
// 18. 최초 실행
// =====================================

window.addEventListener("load", async function() {

  if (!window.kakao || !kakao.maps) {
    statusBox.textContent =
      "카카오맵을 불러오지 못했어요. " +
      "JavaScript 키와 등록 도메인을 확인해 주세요.";
    return;
  }

  map = new kakao.maps.Map(
    document.getElementById("map"),
    {
      center: new kakao.maps.LatLng(
        CENTER.latitude,
        CENTER.longitude
      ),
      level: 9
    }
  );

  const success = await loadAllAccidents();

  if (success) {
    displayMarkers("all");
  }
});
