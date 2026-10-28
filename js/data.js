
/*
  BIKE SAFE 공통 데이터 관리자

  지도와 분석 페이지가 같은 캐시를 사용합니다.
  성공한 데이터는 7일 동안 보관합니다.
  NODATA_ERROR는 24시간 동안 보관합니다.
  일시적인 실패는 5분 뒤 다시 시도합니다.

  HTML/CSS 수정 불필요
*/

import {
  RISK_YEARS,
  RISK_DISTRICTS
} from "./risk.js";

// ========================================
// 1. 여기 한 곳만 수정!
// ========================================

// 기존 map.js에서 사용하던 GAS /exec 주소
const GAS_URL = 
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

// ========================================
// 2. 공통 설정
// ========================================

const DATA_PREFIX = "bicycle_v3_";
const NODATA_PREFIX = "bike_safe_nodata_v1_";
const FAILURE_PREFIX = "bike_safe_failed_v1_";

const DATA_AGE = 7 * 24 * 60 * 60 * 1000;
const NODATA_AGE = 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN = 5 * 60 * 1000;

const REQUEST_TIMEOUT = 30000;
const MAX_RETRIES = 2;
const CONCURRENT_REQUESTS = 2;

// ========================================
// 3. 전체 요청 목록
// ========================================

const jobs = RISK_YEARS.flatMap(year =>
  RISK_DISTRICTS.map(district => ({
    year: String(year),
    district: String(district)
  }))
);

// ========================================
// 4. 현재 데이터 상태
// ========================================

const state = {
  items: [],
  success: [],
  nodata: [],
  failed: [],

  completed: 0,
  total: jobs.length,

  loading: false,
  finished: false
};

const listeners = new Set();

let started = false;
let requestNumber = 0;

// ========================================
// 5. 기본 함수
// ========================================

function jobKey(job) {
  return `${job.year}|${job.district}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readStorage(key) {
  try {
    const text = localStorage.getItem(key);

    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(value)
    );
  } catch (error) {
    console.warn(
      "BIKE SAFE 캐시 저장 실패:",
      error
    );
  }
}

// ========================================
// 6. 캐시 읽기
// ========================================

function readCache(job) {
  const dataKey =
    DATA_PREFIX + job.year + "_" + job.district;

  const saved = readStorage(dataKey);

  if (
    saved &&
    Array.isArray(saved.items) &&
    Number.isFinite(saved.savedAt) &&
    Date.now() - saved.savedAt < DATA_AGE
  ) {
    return {
      status: "success",

      items: saved.items.map(item => ({
        ...item,
        year: job.year,
        districtCode: job.district
      }))
    };
  }

  const noData = readStorage(
    NODATA_PREFIX + jobKey(job)
  );

  if (
    noData &&
    Number.isFinite(noData.savedAt) &&
    Date.now() - noData.savedAt < NODATA_AGE
  ) {
    return {
      status: "nodata",
      items: []
    };
  }

  const failure = readStorage(
    FAILURE_PREFIX + jobKey(job)
  );

  if (
    failure &&
    Number.isFinite(failure.savedAt) &&
    Date.now() - failure.savedAt <
      FAILURE_COOLDOWN
  ) {
    return {
      status: "failed",
      items: [],
      reason: failure.reason || "최근 요청 실패"
    };
  }

  return null;
}

// ========================================
// 7. 페이지에 데이터 상태 전달
// ========================================

export function getSnapshot() {
  return {
    ...state,
    items: [...state.items],
    success: [...state.success],
    nodata: [...state.nodata],
    failed: [...state.failed]
  };
}

export function subscribe(listener) {
  listeners.add(listener);

  listener(getSnapshot());

  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  const snapshot = getSnapshot();

  for (const listener of listeners) {
    listener(snapshot);
  }
}

// ========================================
// 8. GAS JSONP 통신
// ========================================

function requestJSONP(url) {
  return new Promise((resolve, reject) => {
    const callback =
      "bikeSafeShared_" + (++requestNumber);

    const script =
      document.createElement("script");

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
        // 응답이 늦게 도착하는 경우 대비
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

// ========================================
// 9. 사고 데이터 요청
// ========================================

async function fetchJob(job) {
  const url =
    GAS_URL +
    "?year=" + encodeURIComponent(job.year) +
    "&sido=11" +
    "&gugun=" + encodeURIComponent(job.district);

  const response = await requestJSONP(url);

  if (
    response &&
    response.success === true &&
    Array.isArray(response.accidents)
  ) {
    const items = response.accidents.map(item => ({
      ...item,
      year: job.year,
      districtCode: job.district
    }));

    writeStorage(
      DATA_PREFIX + job.year + "_" + job.district,
      {
        savedAt: Date.now(),
        items
      }
    );

    return {
      status: "success",
      items
    };
  }

  const message = String(
    response?.error ||
    response?.message ||
    "INVALID_RESPONSE"
  );

  // 공공데이터에 조회 자료가 없는 경우
  if (/NODATA_ERROR|NO_DATA/i.test(message)) {
    writeStorage(
      NODATA_PREFIX + jobKey(job),
      {
        savedAt: Date.now()
      }
    );

    return {
      status: "nodata",
      items: []
    };
  }

  throw new Error(message);
}

// ========================================
// 10. 일시적인 실패 재시도
// ========================================

async function fetchWithRetry(job) {
  let lastError = null;

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      if (attempt > 0) {
        await sleep(attempt * 1000);
      }

      return await fetchJob(job);

    } catch (error) {
      lastError = error;

      const message = String(
        error.message || ""
      );

      // 인증키 오류 등은 반복 호출하지 않음
      if (
        /SERVICE_KEY|INVALID_RESPONSE|403|401/i
          .test(message)
      ) {
        break;
      }
    }
  }

  const reason = lastError
    ? lastError.message
    : "UNKNOWN_ERROR";

  writeStorage(
    FAILURE_PREFIX + jobKey(job),
    {
      savedAt: Date.now(),
      reason
    }
  );

  return {
    status: "failed",
    items: [],
    reason
  };
}

// ========================================
// 11. 요청 결과 반영
// ========================================

function acceptResult(job, result) {
  if (result.status === "success") {
    state.success.push(job);
    state.items.push(...result.items);

  } else if (result.status === "nodata") {
    state.nodata.push(job);

  } else {
    state.failed.push({
      ...job,
      reason: result.reason || "UNKNOWN_ERROR"
    });
  }

  state.completed++;

  emit();
}

// ========================================
// 12. 전체 데이터 불러오기
// ========================================

export function startLoading() {
  // 같은 페이지에서 중복 실행 방지
  if (started) return;

  started = true;
  state.loading = true;

  const missing = [];

  // 저장된 데이터를 먼저 읽어서 즉시 표시
  for (const job of jobs) {
    const cached = readCache(job);

    if (cached) {
      if (cached.status === "success") {
        state.success.push(job);
        state.items.push(...cached.items);

      } else if (cached.status === "nodata") {
        state.nodata.push(job);

      } else {
        state.failed.push({
          ...job,
          reason: cached.reason || "최근 요청 실패"
        });
      }

      state.completed++;

    } else {
      missing.push(job);
    }
  }

  state.loading = missing.length > 0;
  state.finished = missing.length === 0;

  emit();

  // 전부 저장되어 있으면 API를 다시 부르지 않음
  if (missing.length === 0) return;

  // GAS 주소가 입력되지 않은 경우
  if (
    !GAS_URL.startsWith(
      "https://script.google.com/macros/s/"
    ) ||
    !GAS_URL.endsWith("/exec")
  ) {
    for (const job of missing) {
      acceptResult(job, {
        status: "failed",
        reason: "GAS URL 미설정"
      });
    }

    state.loading = false;
    state.finished = true;
    emit();

    return;
  }

  let cursor = 0;

  // 동시에 최대 2개 요청
  async function worker() {
    while (cursor < missing.length) {
      const job = missing[cursor++];

      const result = await fetchWithRetry(job);

      acceptResult(job, result);
    }
  }

  Promise.all(
    Array.from(
      {
        length: Math.min(
          CONCURRENT_REQUESTS,
          missing.length
        )
      },
      () => worker()
    )
  )
    .catch(error => {
      console.error(
        "BIKE SAFE 공통 API 오류:",
        error
      );
    })
    .finally(() => {
      state.loading = false;
      state.finished = true;

      emit();

      console.info("BIKE SAFE 데이터 조회 결과", {
        success: state.success.length,
        noData: state.nodata.length,
        failed: state.failed.length
      });

      if (state.failed.length > 0) {
        console.table(state.failed);
      }
    });
}
