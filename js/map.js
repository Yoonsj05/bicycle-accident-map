
/*
  자전거 사고 위험지역 분석기
  메인 지도 JavaScript

  주요 기능
  1. GAS를 통한 공공데이터 조회
  2. 서울 전체 사고지역 표시
  3. 연도 및 자치구 필터
  4. 사고 마커 클릭 상세정보
  5. 지도 자동 이동 및 크기 조절
  6. 조회 결과 캐시
*/

// ====================================
// 1. 설정값
// ====================================

// 반드시 본인의 GAS 배포 주소로 수정
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

// 서울 25개 자치구 코드
const DISTRICTS = [
  "680", "740", "305", "500", "620",
  "215", "530", "545", "350", "320",
  "230", "590", "440", "410", "650",
  "200", "290", "710", "470", "560",
  "170", "380", "110", "140", "260"
];

// 서울 중심 좌표
const SEOUL_CENTER = {
  lat: 37.5665,
  lng: 126.9780
};

// 캐시 보관 시간: 1시간
const CACHE_TIME = 60 * 60 * 1000;

// ====================================
// 2. 기본 변수
// ====================================

let map = null;
let markers = [];
let allAccidents = [];
let currentYear = null;

let requestNumber = 0;
let loading = false;
let selectedPosition = null;
let failedDistricts = [];

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

const yearSelect =
  document.getElementById("year");

const districtSelect =
  document.getElementById("district");

const filterButton =
  document.getElementById("filterButton");

const resetButton =
  document.getElementById("resetButton");

// ====================================
// 3. GAS JSONP 요청
// ====================================

function requestJSONP(url) {

  return new Promise(function(resolve, reject) {

    requestNumber++;

    const callbackName =
      "bicycleMapCallback" + requestNumber;

    const script =
      document.createElement("script");

    let finished = false;

    const timer = setTimeout(function() {
      finish(new Error("API 요청 시간이 초과됐어요."));
    }, 20000);

    function cleanup() {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    }

    function finish(error, data) {

      if (finished) return;

      finished = true;
      cleanup();

      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    }

    window[callbackName] = function(data) {
      finish(null, data);
    };

    script.onerror = function() {
      finish(new Error("GAS 서버 연결 실패"));
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
// 4. 캐시 읽기
// ====================================

function readCache(year) {

  try {

    const key = "bicycle_seoul_" + year;
    const stored = localStorage.getItem(key);

    if (!stored) return null;

    const cache = JSON.parse(stored);

    if (
      !cache ||
      !Array.isArray(cache.accidents) ||
      Date.now() - cache.savedAt > CACHE_TIME
    ) {
      localStorage.removeItem(key);
      return null;
    }

    return cache.accidents;

  } catch (error) {
    return null;
  }
}

// ====================================
// 5. 캐시 저장
// ====================================

function saveCache(year, accidents) {

  try {

    localStorage.setItem(
      "bicycle_seoul_" + year,
      JSON.stringify({
        savedAt: Date.now(),
        accidents: accidents
      })
    );

  } catch (error) {
    console.log("캐시 저장 생략");
  }
}

// ====================================
// 6. 카카오맵 생성
// ====================================

function initMap() {

  if (!window.kakao || !kakao.maps) {

    statusBox.textContent =
      "카카오맵 연결에 실패했어요. JavaScript 키를 확인해 주세요.";

    return false;
  }

  map = new kakao.maps.Map(mapElement, {
    center: new kakao.maps.LatLng(
      SEOUL_CENTER.lat,
      SEOUL_CENTER.lng
    ),
    level: 9
  });

  return true;
}

// ====================================
// 7. 지도 크기 반영
// ====================================

function refreshMap(callback) {

  if (!map) return;

  requestAnimationFrame(function() {

    requestAnimationFrame(function() {

      map.relayout();

      if (callback) {
        callback();
      }
    });
  });
}

// ====================================
// 8. 자치구별 데이터 조회
// ====================================

async function fetchDistrict(year, district) {

  const query =
    "?year=" + encodeURIComponent(year) +
    "&sido=11" +
    "&gugun=" + encodeURIComponent(district);

  const data =
    await requestJSONP(GAS_URL + query);

  if (!data || !data.success) {

    throw new Error(
      data && data.error
        ? data.error
        : "공공데이터 API 응답 오류"
    );
  }

  const items =
    Array.isArray(data.accidents)
      ? data.accidents
      : [];

  return items.map(function(item) {

    return {
      ...item,
      districtCode: district
    };
  });
}

// ====================================
// 9. 서울 전체 사고 데이터 조회
// ====================================

async function loadAllAccidents(year) {

  if (!map || loading) return false;

  if (
    !GAS_URL.startsWith(
      "https://script.google.com/macros/s/"
    ) ||
    !GAS_URL.endsWith("/exec")
  ) {

    statusBox.textContent =
      "GAS 웹 앱 URL을 확인해 주세요.";

    return false;
  }

  loading = true;
  filterButton.disabled = true;
  resetButton.disabled = true;

  try {

    const cached = readCache(year);

    if (cached !== null) {

      allAccidents = cached;
      currentYear = year;
      failedDistricts = [];

      return true;
    }

    const results = [];
    const failures = [];

    let nextIndex = 0;
    let completed = 0;

    // 동시에 최대 4개 구 조회
    async function worker() {

      while (nextIndex < DISTRICTS.length) {

        const index = nextIndex++;
        const district = DISTRICTS[index];

        try {

          const items =
            await fetchDistrict(year, district);

          results.push(...items);

        } catch (error) {

          failures.push(district);

          console.error(
            district + " 조회 실패:",
            error
          );
        }

        completed++;

        statusBox.textContent =
          "서울 전체 조회 중... " +
          completed + " / " +
          DISTRICTS.length + "개 구 완료";
      }
    }

    await Promise.all([
      worker(),
      worker(),
      worker(),
      worker()
    ]);

    if (failures.length === DISTRICTS.length) {

      throw new Error(
        "모든 자치구 조회에 실패했어요."
      );
    }

    allAccidents = results;
    currentYear = year;
    failedDistricts = failures;

    // 모두 성공했을 때만 캐시 저장
    if (failures.length === 0) {

      saveCache(year, results);
    }

    return true;

  } catch (error) {

    statusBox.textContent =
      "데이터 조회 실패: " + error.message;

    console.error(error);

    return false;

  } finally {

    loading = false;
    filterButton.disabled = false;
    resetButton.disabled = false;
  }
}

// ====================================
// 10. 기존 마커 제거
// ====================================

function clearMarkers() {

  markers.forEach(function(marker) {
    marker.setMap(null);
  });

  markers = [];
}

// ====================================
// 11. 마커 표시 및 지역 이동
// ====================================

function displayMarkers(district) {

  clearMarkers();
  closeDetailPanel();

  const filtered =
    district === "all"
      ? allAccidents
      : allAccidents.filter(function(item) {
          return item.districtCode === district;
        });

  const bounds = new kakao.maps.LatLngBounds();

  let validCount = 0;

  filtered.forEach(function(item) {

    if (
      item.latitude == null ||
      item.longitude == null
    ) {
      return;
    }

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
      return;
    }

    const position =
      new kakao.maps.LatLng(
        latitude,
        longitude
      );

    const marker =
      new kakao.maps.Marker({
        map: map,
        position: position,
        title: item.name || "사고다발지역"
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

  // 사고지역 위치로 자동 이동
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

  const districtName =
    district === "all"
      ? "서울 전체"
      : "서울 " +
        districtSelect.options[
          districtSelect.selectedIndex
        ].text;

  document.getElementById(
    "currentRegion"
  ).textContent =
    "현재 표시: " +
    currentYear + "년 " + districtName;

  // 조회 실패와 실제 0건을 구분
  if (
    district !== "all" &&
    failedDistricts.includes(district)
  ) {

    statusBox.textContent =
      districtName +
      "의 API 조회에 실패했어요. " +
      "사고다발지역이 0곳이라는 뜻은 아니에요.";

    return;
  }

  if (validCount === 0) {

    statusBox.textContent =
      currentYear + "년 " +
      districtName +
      "에 해당하는 사고다발지역 정보가 없습니다.";

  } else {

    statusBox.textContent =
      currentYear + "년 " +
      districtName +
      " 사고다발지역 " +
      validCount + "곳 표시 완료!";
  }

  if (failedDistricts.length > 0) {

    statusBox.textContent +=
      " 단, " + failedDistricts.length +
      "개 자치구의 조회가 실패해 " +
      "일부 데이터가 누락됐을 수 있어요.";
  }
}

// ====================================
// 12. 지역 필터 적용
// ====================================

async function applyFilter() {

  if (loading) return;

  const year = yearSelect.value;
  const district = districtSelect.value;

  if (currentYear !== year) {

    const success =
      await loadAllAccidents(year);

    if (!success) return;
  }

  displayMarkers(district);
}

// ====================================
// 13. 서울 전체 보기
// ====================================

async function resetFilter() {

  if (loading) return;

  districtSelect.value = "all";

  await applyFilter();
}

// ====================================
// 14. 상세정보 행 생성
// ====================================

function createDetailRow(label, value) {

  const row =
    document.createElement("div");

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
// 15. 사고 마커 클릭
// ====================================

function selectAccident(marker, item) {

  selectedPosition = marker.getPosition();

  detailContent.replaceChildren();

  const name =
    document.createElement("div");

  name.className = "region-name";
  name.textContent =
    item.name || "사고다발지역";

  detailContent.appendChild(name);

  const rows = [
    ["사고 건수", item.accidentCount + "건"],
    ["사상자 수", item.casualtyCount + "명"],
    ["사망자 수", item.deathCount + "명"],
    ["중상자 수", item.seriousCount + "명"],
    ["경상자 수", item.minorCount + "명"],
    ["부상신고자 수",
      item.reportedInjuryCount + "명"]
  ];

  rows.forEach(function(row) {

    detailContent.appendChild(
      createDetailRow(
        row[0],
        row[1]
      )
    );
  });

  const scoreBox =
    document.createElement("div");

  scoreBox.className = "score-box";

  const scoreTitle =
    document.createElement("div");

  scoreTitle.textContent =
    "자체 분석 위험도";

  const scoreNumber =
    document.createElement("strong");

  scoreNumber.className = "score-number";
  scoreNumber.textContent =
    item.riskScore + "점";

  scoreBox.appendChild(scoreTitle);
  scoreBox.appendChild(scoreNumber);

  detailContent.appendChild(scoreBox);

  const note =
    document.createElement("p");

  note.className = "score-caption";
  note.textContent =
    "공식 위험등급이 아닌 과제용 자체 분석 점수입니다.";

  detailContent.appendChild(note);

  // 왼쪽 상세정보 패널 표시
  mapLayout.classList.add("active");

  updateMapHeight();

  // 선택한 사고 위치를 오른쪽 지도 중앙으로
  refreshMap(function() {

    map.setCenter(selectedPosition);

    if (map.getLevel() > 5) {
      map.setLevel(5);
    }
  });

  statusBox.textContent =
    "선택한 사고지역: " +
    item.name +
    " / 위험도 " +
    item.riskScore + "점";
}

// ====================================
// 16. 정보 패널과 지도 높이 맞추기
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
      Math.max(480, height) + "px";
  }
}

// ====================================
// 17. 상세정보 닫기
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

    if (center) {
      map.setCenter(center);
    }
  });
}

// ====================================
// 18. 화면 크기 변경
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
// 19. 웹페이지 시작
// ====================================

window.addEventListener("load", async function() {

  const success = initMap();

  if (!success) return;

  // 처음에는 서울 전체 사고지역 표시
  const loaded =
    await loadAllAccidents("2023");

  if (loaded) {
    displayMarkers("all");
  }
});
