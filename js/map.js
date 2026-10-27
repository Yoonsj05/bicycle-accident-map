
/*
 * 자전거 사고 위험지역 분석기
 * 2021~2023년 통합 지도
 * 서울 자치구 필터 + 연도별 사고 표
 */

// ====================================
// 1. 기본 설정
// ====================================

// 본인의 GAS 웹 앱 URL을 입력하세요.
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

const SEOUL_CENTER = {
  lat: 37.5665,
  lng: 126.9780
};

const CACHE_TIME = 60 * 60 * 1000;

let map = null;
let markers = [];
let allAccidents = [];
let groupedAccidents = [];

let requestNumber = 0;
let loading = false;
let selectedPosition = null;
let failedRequests = [];

const mapElement =
  document.getElementById("map");

const mapLayout =
  document.getElementById("mapLayout");

const detailPanel =
  document.getElementById("detailPanel");

const detailContent =
  document.getElementById("detailContent");

const statusBox =
  document.getElementById("status");

const districtSelect =
  document.getElementById("district");

const filterButton =
  document.getElementById("filterButton");

const resetButton =
  document.getElementById("resetButton");

// ====================================
// 2. JSONP 요청
// ====================================

function requestJSONP(url) {
  return new Promise(function(resolve, reject) {

    const callbackName =
      "bicycleCallback" + (++requestNumber);

    const script = document.createElement("script");

    let finished = false;

    const timer = setTimeout(function() {
      finish(new Error("요청 시간 초과"));
    }, 30000);

    function cleanup() {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    }

    function finish(error, data) {
      if (finished) return;

      finished = true;
      cleanup();

      if (error) reject(error);
      else resolve(data);
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

// ====================================
// 3. 자치구·연도별 캐시
// ====================================

function cacheKey(year, district) {
  return "bicycle_v3_" + year + "_" + district;
}

function readCache(year, district) {
  try {
    const text = localStorage.getItem(
      cacheKey(year, district)
    );

    if (!text) return null;

    const cache = JSON.parse(text);

    if (
      !cache ||
      !Array.isArray(cache.items) ||
      Date.now() - cache.savedAt > CACHE_TIME
    ) {
      return null;
    }

    return cache.items;

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
    console.log("브라우저 캐시 저장 생략");
  }
}

// ====================================
// 4. 개별 API 조회
// ====================================

async function fetchDistrictYear(year, district) {

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

  if (!data || !data.success) {
    throw new Error(
      data && data.error
        ? data.error
        : "API 응답 오류"
    );
  }

  const items = Array.isArray(data.accidents)
    ? data.accidents
    : [];

  const result = items.map(function(item) {
    return {
      ...item,
      year: year,
      districtCode: district
    };
  });

  saveCache(year, district, result);

  return result;
}

// ====================================
// 5. 전체 데이터 가져오기
// ====================================

async function loadAllAccidents() {

  if (loading) return false;

  if (
    !GAS_URL.startsWith(
      "https://script.google.com/macros/s/"
    ) ||
    !GAS_URL.endsWith("/exec")
  ) {
    statusBox.textContent =
      "js/map.js의 GAS 웹 앱 URL을 확인해 주세요.";
    return false;
  }

  loading = true;
  filterButton.disabled = true;
  resetButton.disabled = true;

  const jobs = [];

  YEARS.forEach(function(year) {
    DISTRICTS.forEach(function(district) {
      jobs.push({ year, district });
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
        const items = await fetchDistrictYear(
          job.year,
          job.district
        );

        results.push(...items);

      } catch (error) {
        failures.push(job);
        console.error(
          job.year + "/" + job.district,
          error
        );
      }

      completed++;

      statusBox.textContent =
        "사고지역 데이터 조회 중... " +
        completed + " / " +
        jobs.length + "개 요청 완료";
    }
  }

  try {
    // 서버에 과도한 요청이 몰리지 않게
    // 동시에 최대 3개만 조회
    await Promise.all([
      worker(),
      worker(),
      worker()
    ]);

    if (failures.length === jobs.length) {
      throw new Error(
        "모든 API 요청에 실패했어요."
      );
    }

    allAccidents = results;
    failedRequests = failures;

    groupAccidents();

    return true;

  } catch (error) {
    statusBox.textContent =
      "데이터 조회 오류: " + error.message;

    console.error(error);
    return false;

  } finally {
    loading = false;
    filterButton.disabled = false;
    resetButton.disabled = false;
  }
}

// ====================================
// 6. 연도별 동일 사고지역 묶기
// ====================================

function groupAccidents() {

  const groups = new Map();

  allAccidents.forEach(function(item) {

    // 이름과 자치구 코드로 동일 지역 판단
    const normalizedName = String(
      item.name || ""
    )
      .replace(/\s+/g, "")
      .trim();

    const key =
      item.districtCode + "|" + normalizedName;

    if (!normalizedName) return;

    if (!groups.has(key)) {
      groups.set(key, {
        name: item.name,
        districtCode: item.districtCode,
        records: {},
        latitude: null,
        longitude: null,
        riskScore: 0,
        accidentCount: 0,
        casualtyCount: 0
      });
    }

    const group = groups.get(key);

    // 같은 연도에 같은 이름의 기록이 여럿이면
    // 건수와 피해를 합산
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

    const record = group.records[item.year];

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
      record[field] += Number(item[field]) || 0;
    });

    group.accidentCount +=
      Number(item.accidentCount) || 0;

    group.casualtyCount +=
      Number(item.casualtyCount) || 0;

    group.riskScore +=
      Number(item.riskScore) || 0;

    // 좌표가 유효하면 지도 마커에 활용
    const lat = Number(item.latitude);
    const lng = Number(item.longitude);

    if (
      item.latitude != null &&
      item.longitude != null &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= 33 && lat <= 39 &&
      lng >= 124 && lng <= 132
    ) {
      group.latitude = lat;
      group.longitude = lng;
    }
  });

  groupedAccidents = Array.from(groups.values());
}

// ====================================
// 7. 지도 크기 재설정
// ====================================

function refreshMap(callback) {

  if (!map) return;

  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      map.relayout();

      if (callback) callback();
    });
  });
}

// ====================================
// 8. 마커 모두 제거
// ====================================

function clearMarkers() {
  markers.forEach(function(marker) {
    marker.setMap(null);
  });

  markers = [];
}

// ====================================
// 9. 지역별 마커 표시
// ====================================

function displayMarkers(district) {

  clearMarkers();
  closeDetailPanel();

  const items = district === "all"
    ? groupedAccidents
    : groupedAccidents.filter(function(item) {
        return item.districtCode === district;
      });

  const bounds = new kakao.maps.LatLngBounds();

  let validCount = 0;

  items.forEach(function(item) {

    if (
      item.latitude == null ||
      item.longitude == null
    ) return;

    const position = new kakao.maps.LatLng(
      item.latitude,
      item.longitude
    );

    const marker = new kakao.maps.Marker({
      map: map,
      position: position,
      title: item.name
    });

    markers.push(marker);
    bounds.extend(position);
    validCount++;

    kakao.maps.event.addListener(
      marker,
      "click",
      function() {
        selectAccident(marker, item);
      }
    );
  });

  refreshMap(function() {

    if (validCount === 1) {
      map.setCenter(
        markers[0].getPosition()
      );
      map.setLevel(5);

    } else if (validCount > 1) {
      map.setBounds(
        bounds, 60, 60, 60, 60
      );

    } else if (district === "all") {
      map.setCenter(
        new kakao.maps.LatLng(
          SEOUL_CENTER.lat,
          SEOUL_CENTER.lng
        )
      );
      map.setLevel(9);
    }
  });

  const name = district === "all"
    ? "서울 전체"
    : "서울 " +
      districtSelect.options[
        districtSelect.selectedIndex
      ].text;

  document.getElementById(
    "currentRegion"
  ).textContent =
    "현재 표시: " + name +
    " · 2021~2023년";

  const missing = failedRequests.filter(
    function(job) {
      return district === "all" ||
        job.district === district;
    }
  );

  if (validCount === 0) {
    statusBox.textContent =
      name +
      "에 해당하는 사고다발지역 기록이 " +
      "조회되지 않았어요.";

  } else {
    statusBox.textContent =
      name + "에서 사고다발지역 " +
      validCount +
      "곳을 지도에 표시했어요.";
  }

  if (missing.length > 0) {
    statusBox.textContent +=
      " 단, " + missing.length +
      "개 연도·지역 요청이 실패해 " +
      "결과가 일부 누락됐을 수 있어요.";
  }
}

// ====================================
// 10. 지역 필터
// ====================================

function applyFilter() {

  if (loading) return;

  displayMarkers(districtSelect.value);
}

// ====================================
// 11. 서울 전체 보기
// ====================================

function resetFilter() {

  if (loading) return;

  districtSelect.value = "all";
  displayMarkers("all");
}

// ====================================
// 12. 상세정보 행 만들기
// ====================================

function createDetailRow(label, value) {

  const row = document.createElement("div");
  row.className = "detail-row";

  const labelElement =
    document.createElement("span");

  labelElement.className = "detail-label";
  labelElement.textContent = label;

  const valueElement =
    document.createElement("span");

  valueElement.className = "detail-value";
  valueElement.textContent = value;

  row.appendChild(labelElement);
  row.appendChild(valueElement);

  return row;
}

// ====================================
// 13. 연도별 사고 현황 표
// ====================================

function createYearTable(item) {

  const heading = document.createElement("h4");
  heading.className = "year-heading";
  heading.textContent = "연도별 사고 현황";

  detailContent.appendChild(heading);

  const table = document.createElement("table");
  table.className = "year-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  ["연도", "사고", "사상자"].forEach(
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

    const failed = failedRequests.some(function(job) {
      return job.year === year &&
        job.district === item.districtCode;
    });

    const values = failed
      ? [year, "조회 실패", "-"]
      : record
        ? [
            year,
            record.accidentCount + "건",
            record.casualtyCount + "명"
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
  const totalRow = document.createElement("tr");

  [
    "확인 합계",
    item.accidentCount + "건",
    item.casualtyCount + "명"
  ].forEach(function(value) {
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
    "기록 없음은 해당 연도에 사고다발지역으로 " +
    "조회되지 않았다는 뜻이며, " +
    "실제 사고가 0건이라는 의미는 아니에요.";

  detailContent.appendChild(note);
}

// ====================================
// 14. 마커 클릭 시 상세정보
// ====================================

function selectAccident(marker, item) {

  selectedPosition = marker.getPosition();

  detailContent.replaceChildren();

  const name = document.createElement("div");
  name.className = "region-name";
  name.textContent = item.name;

  detailContent.appendChild(name);

  detailContent.appendChild(
    createDetailRow(
      "확인된 사고 건수",
      item.accidentCount + "건"
    )
  );

  detailContent.appendChild(
    createDetailRow(
      "확인된 사상자 수",
      item.casualtyCount + "명"
    )
  );

  createYearTable(item);

  const scoreBox = document.createElement("div");
  scoreBox.className = "score-box";

  const scoreTitle =
    document.createElement("div");
  scoreTitle.textContent =
    "확인된 기록의 위험도 점수 합계";

  const scoreNumber =
    document.createElement("strong");
  scoreNumber.className = "score-number";
  scoreNumber.textContent =
    item.riskScore + "점";

  scoreBox.appendChild(scoreTitle);
  scoreBox.appendChild(scoreNumber);
  detailContent.appendChild(scoreBox);

  const note = document.createElement("p");
  note.className = "score-caption";
  note.textContent =
    "사고 건수와 인명피해를 기준으로 계산한 " +
    "과제용 자체 분석 점수예요.";

  detailContent.appendChild(note);

  // 패널을 열고 지도 크기 변경
  mapLayout.classList.add("active");

  updateMapHeight();

  refreshMap(function() {
    map.setCenter(selectedPosition);

    if (map.getLevel() > 5) {
      map.setLevel(5);
    }
  });
}

// ====================================
// 15. 지도와 패널 높이 맞추기
// ====================================

function updateMapHeight() {

  if (!mapLayout.classList.contains("active")) {
    mapElement.style.height = "";
    return;
  }

  if (window.innerWidth <= 760) {
    mapElement.style.height = "400px";
  } else {
    const height =
      detailPanel.getBoundingClientRect().height;

    mapElement.style.height =
      Math.max(540, height) + "px";
  }
}

// ====================================
// 16. 상세정보 닫기
// ====================================

function closeDetailPanel() {

  const center =
    selectedPosition ||
    (map ? map.getCenter() : null);

  mapLayout.classList.remove("active");
  detailContent.replaceChildren();

  mapElement.style.height = "";
  selectedPosition = null;

  refreshMap(function() {
    if (center) map.setCenter(center);
  });
}

// ====================================
// 17. 브라우저 크기 변경
// ====================================

window.addEventListener("resize", function() {
  if (!map) return;

  const center =
    selectedPosition || map.getCenter();

  updateMapHeight();

  refreshMap(function() {
    map.setCenter(center);
  });
});

// ====================================
// 18. 페이지 시작
// ====================================

window.addEventListener("load", async function() {

  if (!window.kakao || !kakao.maps) {
    statusBox.textContent =
      "카카오맵 연결에 실패했어요.";
    return;
  }

  map = new kakao.maps.Map(mapElement, {
    center: new kakao.maps.LatLng(
      SEOUL_CENTER.lat,
      SEOUL_CENTER.lng
    ),
    level: 9
  });

  const success = await loadAllAccidents();

  if (success) {
    displayMarkers("all");
  }
});
