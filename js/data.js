
/*
  BIKE SAFE - 공통 데이터 관리자

  역할:
  1. 2021~2023년 서울 25개 자치구 데이터 조회
  2. Google Apps Script(JSONP) 호출
  3. 지도와 사고 분석 페이지의 캐시 공유
  4. 성공 / 자료 없음 / 요청 실패 구분
  5. 실패 시 최대 2회 재시도

  이번 점검:
  - 캐시된 요청 실패를 자료 없음으로 잘못 처리하던 문제 수정
  - GAS URL 설정 여부 검사
  - 요청 상태 및 오류 처리 정리

  HTML / CSS / 지도 디자인 변경 없음
*/

import {
  RISK_YEARS,
  RISK_DISTRICTS
} from "./risk.js";

// ========================================
// 1. GAS 웹 앱 주소
// ========================================

// 기존에 사용하던 GAS 배포 URL을 입력하세요.
// 반드시 /exec로 끝나는 주소여야 합니다.

const GAS_URL = 
  "https://script.google.com/macros/s/AKfycbwo75CLBCXVNfJ9R55fC9VYeFpiOjhbJ02w3WRXi2qnSuQ_ug8OAthWHC63pnJE819MTQ/exec";

// ========================================
// 2. 캐시 설정
// ========================================

// 기존 저장 데이터와 호환되는 이름
const DATA_PREFIX = "bicycle_v3_";

const NO_DATA_PREFIX = "bike_safe_nodata_v1_";
const FAILURE_PREFIX = "bike_safe_failed_v1_";

// 성공한 데이터: 7일
const DATA_AGE = 7 * 24 * 60 * 60 * 1000;

// 자료 없음: 24시간
const NO_DATA_AGE = 24 * 60 * 60 * 1000;

// 요청 실패: 5분간 재시도 제한
const FAILURE_COOLDOWN = 5 * 60 * 1000;

// API 요청 설정
const TIMEOUT = 30000;
const MAX_RETRIES = 2;
const CONCURRENCY = 2;

// ========================================
// 3. 조회 작업 목록
// ========================================

const jobs = RISK_YEARS.flatMap(year =>
  RISK_DISTRICTS.map(district => ({
    year,
    district
  }))
);

// ========================================
// 4. 공통 상태
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

function dataKey(job) {
  return (
    DATA_PREFIX +
    job.year +
    "_" +
    job.district
  );
}

function readStorage(key) {
  try {
    const value = localStorage.getItem(key);

    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.warn(
      "BIKE SAFE 캐시 읽기 실패:",
      error
    );

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

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn(
      "BIKE SAFE 캐시 삭제 실패:",
      error
    );
  }
}

function isFresh(record, maxAge) {
  if (
    !record ||
    !Number.isFinite(record.savedAt)
  ) {
    return false;
  }

  const age = Date.now() - record.savedAt;

  return age >= 0 && age < maxAge;
}

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

// ========================================
// 6. 캐시 확인
// ========================================

function cacheFor(job) {
  const saved = readStorage(dataKey(job));

  // 기존 정상 데이터 재사용
  if (
    isFresh(saved, DATA_AGE) &&
    Array.isArray(saved.items)
  ) {
    return {
      status: "success",
      items: saved.items.map(item => ({
        ...item,
        year: String(job.year),
        districtCode: String(job.district)
      }))
    };
  }

  // API가 명시적으로 자료 없음 응답
  const noData = readStorage(
    NO_DATA_PREFIX + jobKey(job)
  );

  if (isFresh(noData, NO_DATA_AGE)) {
    return {
      status: "nodata",
      items: []
    };
  }

  // 이전에 요청 실패한 경우
  const failure = readStorage(
    FAILURE_PREFIX + jobKey(job)
  );

  if (
    isFresh(
      failure,
      FAILURE_COOLDOWN
    )
  ) {
    return {
      status: "failed",
      items: [],
      reason:
        failure.reason ||
        "최근 API 요청 실패"
    };
  }

  return null;
}

// ========================================
// 7. 상태 공유
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

function emit() {
  const snapshot = getSnapshot();

  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error(
        "BIKE SAFE 화면 갱신 오류:",
        error
      );
    }
  }
}

export function subscribe(listener) {
  if (typeof listener !== "function") {
    throw new TypeError(
      "subscribe에는 함수가 필요합니다."
    );
  }

  listeners.add(listener);

  // 현재 상태 즉시 전달
  listener(getSnapshot());

  // 구독 해제 함수
  return () => {
    listeners.delete(listener);
  };
}

// ========================================
// 8. GAS 주소 검사
// ========================================

function isValidGasUrl() {
  try {
    const url = new URL(GAS_URL);

    return (
      url.protocol === "https:" &&
      url.hostname === "script.google.com" &&
      /^\/macros\/s\/[^/]+\/exec\/?$/.test(
        url.pathname
      )
    );
  } catch (error) {
    return false;
  }
}

// ========================================
// 9. JSONP API 요청
// ========================================

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const callback =
      "bikeSafeShared_" +
      (++requestNumber);

    const script =
      document.createElement("script");

    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error("TIMEOUT"));
    }, TIMEOUT);

    function finish(error, data) {
      if (settled) return;

      settled = true;

      clearTimeout(timer);
      script.remove();

      if (error) {
        // 늦게 실행된 JSONP 응답으로
        // 오류가 발생하지 않도록 보호
        window[callback] = () => {};

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
      finish(
        new Error("NETWORK_ERROR")
      );
    };

    const separator = url.includes("?")
      ? "&"
      : "?";

    script.src =
      url +
      separator +
      "callback=" +
      encodeURIComponent(callback);

    document.body.appendChild(script);
  });
}

// ========================================
// 10. 실제 데이터 요청
// ========================================

async function request(job) {
  const separator = GAS_URL.includes("?")
    ? "&"
    : "?";

  const url =
    GAS_URL +
    separator +
    "year=" +
    encodeURIComponent(job.year) +
    "&sido=11" +
    "&gugun=" +
    encodeURIComponent(job.district);

  const result = await jsonp(url);

  // 정상 응답
  if (
    result &&
    result.success === true &&
    Array.isArray(result.accidents)
  ) {
    const items = result.accidents.map(
      item => ({
        ...item,
        year: String(job.year),
        districtCode: String(job.district)
      })
    );

    writeStorage(
      dataKey(job),
      {
        savedAt: Date.now(),
        items
      }
    );

    // 과거 실패 상태는 더 이상 필요 없음
    removeStorage(
      FAILURE_PREFIX + jobKey(job)
    );

    removeStorage(
      NO_DATA_PREFIX + jobKey(job)
    );

    return {
      status: "success",
      items
    };
  }

  // GAS에서 반환한 오류 메시지
  const message = String(
    result?.error ||
    result?.message ||
    "INVALID_RESPONSE"
  );

  // 공공데이터 API의 자료 없음 응답
  if (
    /NODATA_ERROR|NO_DATA/i.test(message)
  ) {
    writeStorage(
      NO_DATA_PREFIX + jobKey(job),
      {
        savedAt: Date.now()
      }
    );

    removeStorage(
      FAILURE_PREFIX + jobKey(job)
    );

    return {
      status: "nodata",
      items: []
    };
  }

  // 나머지 오류는 요청 실패
  throw new Error(message);
}

// ========================================
// 11. 실패 시 재시도
// ========================================

async function retry(job) {
  let lastError = null;

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      if (attempt > 0) {
        await delay(attempt * 1000);
      }

      return await request(job);
    } catch (error) {
      lastError = error;

      const message = String(
        error?.message || error
      );

      // 인증 및 응답 형식 오류는
      // 반복 호출해도 해결되지 않음
      if (
        /SERVICE_KEY|INVALID_RESPONSE|403|401/i
          .test(message)
      ) {
        break;
      }
    }
  }

  const reason =
    lastError?.message ||
    "UNKNOWN_ERROR";

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
// 12. 조회 결과 반영
// ========================================

function accept(job, result) {
  if (result.status === "success") {
    state.success.push(job);

    state.items.push(
      ...result.items
    );
  } else if (result.status === "nodata") {
    state.nodata.push(job);
  } else {
    state.failed.push({
      ...job,
      reason:
        result.reason ||
        "요청 실패"
    });
  }

  state.completed++;

  emit();
}

// ========================================
// 13. 전체 데이터 조회 시작
// ========================================

export function startLoading() {
  // 중복 실행 방지
  if (started) return;

  started = true;

  state.loading = true;

  const missing = [];

  // 기존 캐시부터 확인
  for (const job of jobs) {
    const cached = cacheFor(job);

    if (!cached) {
      missing.push(job);
      continue;
    }

    // 성공 캐시
    if (cached.status === "success") {
      state.success.push(job);

      state.items.push(
        ...cached.items
      );
    }

    // 자료 없음 캐시
    else if (cached.status === "nodata") {
      state.nodata.push(job);
    }

    // 실패 캐시
    // 핵심 수정: 자료 없음으로 처리하지 않음
    else if (cached.status === "failed") {
      state.failed.push({
        ...job,
        reason:
          cached.reason ||
          "최근 요청 실패"
      });
    }

    state.completed++;
  }

  // 캐시만으로 모두 조회된 경우
  if (missing.length === 0) {
    state.loading = false;
    state.finished = true;

    emit();

    return;
  }

  // 캐시된 데이터 먼저 화면에 표시
  state.loading = true;
  state.finished = false;

  emit();

  // GAS 주소 확인
  if (!isValidGasUrl()) {
    for (const job of missing) {
      accept(job, {
        status: "failed",
        items: [],
        reason: "GAS URL 미설정 또는 형식 오류"
      });
    }

    state.loading = false;
    state.finished = true;

    emit();

    console.error(
      "BIKE SAFE: data.js의 GAS_URL을 확인하세요."
    );

    return;
  }

  // ======================================
  // API 요청 작업자
  // ======================================

  let cursor = 0;

  async function worker() {
    while (cursor < missing.length) {
      const job = missing[cursor++];

      let result;

      try {
        result = await retry(job);
      } catch (error) {
        result = {
          status: "failed",
          items: [],
          reason:
            error?.message ||
            "UNKNOWN_ERROR"
        };
      }

      accept(job, result);
    }
  }

  const workerCount = Math.min(
    CONCURRENCY,
    missing.length
  );

  const workers = Array.from(
    { length: workerCount },
    () => worker()
  );

  Promise.all(workers)
    .catch(error => {
      console.error(
        "BIKE SAFE 공통 요청 오류:",
        error
      );
    })
    .finally(() => {
      state.loading = false;
      state.finished = true;

      emit();

      console.info(
        "BIKE SAFE 데이터 조회 완료",
        {
          total: state.total,
          success: state.success.length,
          nodata: state.nodata.length,
          failed: state.failed.length
        }
      );
    });
}
