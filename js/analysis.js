
/*
 * 자전거 사고 위험지역 분석기
 * 사고 분석 페이지 전용 JavaScript
 * 2021~2023년 통합 분석
 */

// 본인의 GAS 웹 앱 URL로 변경
const ANALYSIS_GAS_URL =
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

const ANALYSIS_YEARS = ["2021", "2022", "2023"];

const ANALYSIS_DISTRICTS = [
  "680", "740", "305", "500", "620",
  "215", "530", "545", "350", "320",
  "230", "590", "440", "410", "650",
  "200", "290", "710", "470", "560",
  "170", "380", "110", "140", "260"
];

const ANALYSIS_CACHE_TIME = 60 * 60 * 1000;

let analysisData = [];
let analysisFailures = [];
let analysisLoading = false;
let analysisRequestId = 0;

// ================================
// 1. GAS에서 JSONP 데이터 가져오기
// ================================

function analysisJSONP(url) {
  return new Promise(function(resolve, reject) {
    const callbackName =
      "analysisCallback" + (++analysisRequestId);

    const script = document.createElement("script");
    let completed = false;

    const timer = setTimeout(function() {
      finish(new Error("요청 시간이 초과됐어요."));
    }, 30000);

    function finish(error, data) {
      if (completed) return;
      completed = true;

      clearTimeout(timer);
      script.remove();

      // 늦게 도착한 응답에 대비
      if (error) {
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
      finish(new Error("GAS 연결에 실패했어요."));
    };

    script.src =
      url +
      (url.includes("?") ? "&" : "?") +
      "callback=" + encodeURIComponent(callbackName);

    document.body.appendChild(script);
  });
}

// ================================
// 2. 기존 지도 페이지의 캐시 활용
// ================================

function getAnalysisCache(year, district) {
  try {
    const key = "bicycle_v3_" + year + "_" + district;
    const stored = localStorage.getItem(key);

    if (!stored) return null;

    const cache = JSON.parse(stored);

    if (
      !cache ||
      !Array.isArray(cache.items) ||
      Date.now() - cache.savedAt > ANALYSIS_CACHE_TIME
    ) {
      return null;
    }

    return cache.items;
  } catch (error) {
    return null;
  }
}

function saveAnalysisCache(year, district, items) {
  try {
    localStorage.setItem(
      "bicycle_v3_" + year + "_" + district,
      JSON.stringify({
        savedAt: Date.now(),
        items: items
      })
    );
  } catch (error) {
    console.log("캐시 저장을 생략했어요.");
  }
}

// ================================
// 3. 연도·지역별 사고 데이터 요청
// ================================

async function fetchAnalysisData(year, district) {
  const cached = getAnalysisCache(year, district);

  if (cached !== null) return cached;

  const url =
    ANALYSIS_GAS_URL +
    "?year=" + encodeURIComponent(year) +
    "&sido=11" +
    "&gugun=" + encodeURIComponent(district);

  const data = await analysisJSONP(url);

  if (!data || !data.success) {
    throw new Error(
      data && data.error
        ? data.error
        : "공공데이터 조회 오류"
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

  saveAnalysisCache(year, district, result);

  return result;
}

// ================================
// 4. 여러 연도 통합 조회
// ================================

async function loadAnalysisData(district) {
  if (analysisLoading) return;

  const status = document.getElementById("analysisStatus");
  const button = document.getElementById("analyzeButton");

  if (
    !ANALYSIS_GAS_URL.startsWith(
      "https://script.google.com/macros/s/"
    ) ||
    !ANALYSIS_GAS_URL.endsWith("/exec")
  ) {
    status.textContent =
      "analysis.js의 GAS 웹 앱 주소를 확인해 주세요.";
    return;
  }

  analysisLoading = true;
  button.disabled = true;

  const districts = district === "all"
    ? ANALYSIS_DISTRICTS
    : [district];

  const jobs = [];

  ANALYSIS_YEARS.forEach(function(year) {
    districts.forEach(function(code) {
      jobs.push({
        year: year,
        district: code
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
        const items = await fetchAnalysisData(
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

      status.textContent =
        "데이터 분석 준비 중... " +
        completed + "/" + jobs.length;
    }
  }

  try {
    // 요청은 동시에 최대 3개
    await Promise.all([
      worker(),
      worker(),
      worker()
    ]);

    if (failures.length === jobs.length) {
      throw new Error(
        "데이터 요청이 모두 실패했어요."
      );
    }

    analysisData = results;
    analysisFailures = failures;

    renderAnalysis(district);
  } catch (error) {
    status.textContent =
      "데이터 분석 실패: " + error.message;
  } finally {
    analysisLoading = false;
    button.disabled = false;
  }
}

// ================================
// 5. 동일 사고지역의 연도별 기록 통합
// ================================

function groupAnalysisData(items) {
  const groups = new Map();

  items.forEach(function(item) {
    const normalizedName = String(item.name || "")
      .replace(/\s+/g, "")
      .trim();

    if (!normalizedName) return;

    const key =
      item.districtCode + "|" + normalizedName;

    if (!groups.has(key)) {
      groups.set(key, {
        name: item.name,
        districtCode: item.districtCode,
        accidentCount: 0,
        casualtyCount: 0,
        riskScore: 0,
        years: new Set()
      });
    }

    const group = groups.get(key);

    group.accidentCount +=
      Number(item.accidentCount) || 0;

    group.casualtyCount +=
      Number(item.casualtyCount) || 0;

    group.riskScore +=
      Number(item.riskScore) || 0;

    group.years.add(item.year);
  });

  return Array.from(groups.values());
}

// ================================
// 6. 분석 결과 출력
// ================================

function renderAnalysis(district) {
  const status = document.getElementById("analysisStatus");
  const stats = document.getElementById("analysisStats");
  const ranking = document.getElementById("analysisRanking");
  const coverage = document.getElementById("analysisCoverage");

  const groups = groupAnalysisData(analysisData);

  const totalAccidents = analysisData.reduce(
    function(sum, item) {
      return sum + (Number(item.accidentCount) || 0);
    }, 0
  );

  const totalCasualties = analysisData.reduce(
    function(sum, item) {
      return sum + (Number(item.casualtyCount) || 0);
    }, 0
  );

  const regionSelect =
    document.getElementById("analysisDistrict");

  const regionName = district === "all"
    ? "서울 전체"
    : "서울 " +
      regionSelect.options[regionSelect.selectedIndex].text;

  document.getElementById("analysisSpotCount")
    .textContent = groups.length;

  document.getElementById("analysisAccidentCount")
    .textContent = totalAccidents.toLocaleString();

  document.getElementById("analysisCasualtyCount")
    .textContent = totalCasualties.toLocaleString();

  stats.hidden = false;
  ranking.replaceChildren();

  const sorted = groups.sort(function(a, b) {
    return b.riskScore - a.riskScore;
  });

  const topFive = sorted.slice(0, 5);
  const maxScore = Math.max(
    1,
    ...topFive.map(function(item) {
      return item.riskScore;
    })
  );

  if (topFive.length === 0) {
    const message = document.createElement("p");
    message.className = "empty";
    message.textContent =
      "조회된 사고다발지역 정보가 없습니다.";
    ranking.appendChild(message);
  }

  topFive.forEach(function(item, index) {
    const row = document.createElement("div");
    row.className = "ranking-item";

    const title = document.createElement("div");
    title.className = "ranking-title";
    title.textContent =
      (index + 1) + "위. " + item.name;

    const info = document.createElement("p");
    info.className = "ranking-info";
    info.textContent =
      "사고 " + item.accidentCount + "건 · " +
      "사상자 " + item.casualtyCount + "명 · " +
      "위험도 " + item.riskScore + "점";

    const barBackground = document.createElement("div");
    barBackground.className = "bar-background";

    const bar = document.createElement("div");
    bar.className = "bar";

    bar.style.width =
      ((item.riskScore / maxScore) * 100) + "%";

    barBackground.appendChild(bar);

    row.appendChild(title);
    row.appendChild(info);
    row.appendChild(barBackground);

    ranking.appendChild(row);
  });

  status.textContent =
    regionName + " · 2021~2023년 분석 완료";

  const expectedRequests =
    ANALYSIS_YEARS.length *
    (district === "all"
      ? ANALYSIS_DISTRICTS.length
      : 1);

  const successfulRequests =
    expectedRequests - analysisFailures.length;

  coverage.textContent =
    "연도·지역별 요청 " +
    expectedRequests + "개 중 " +
    successfulRequests + "개 성공.";

  if (analysisFailures.length > 0) {
    coverage.textContent +=
      " 일부 데이터가 누락됐으므로 " +
      "분석 결과는 불완전할 수 있어요.";
  } else if (groups.length === 0) {
    coverage.textContent +=
      " 해당 조건에서 조회된 사고다발지역이 없어요. " +
      "실제 사고가 0건이라는 뜻은 아니에요.";
  }
}

// ================================
// 7. 분석 버튼
// ================================

function analyzeRegion() {
  if (analysisLoading) return;

  const district = document.getElementById(
    "analysisDistrict"
  ).value;

  loadAnalysisData(district);
}

// ================================
// 8. 페이지 시작
// ================================

window.addEventListener("load", function() {
  if (!document.getElementById("analysisDistrict")) {
    return;
  }

  loadAnalysisData("all");
});
