const BASE_MONTH = monthKey(new Date());
let MONTHLY_INCOME = 0;
let REPORTED_MONTHLY_OUTFLOW = 0;


const lenderMeta = {};

let importedRecords = {};
const DEFAULT_SETTINGS = { reminders: true, monthlyRoll: true, dark: false };
const NUMERIC_LOAN_FIELDS = ["original", "outstanding", "emi", "rate", "dueDay", "tenureMonths", "remainingInstallments", "fixedInterest"];

const state = {
  loans: [],
  customLoans: [],
  payments: {},
  documents: [],
  settings: { ...DEFAULT_SETTINGS },
  selectedMonth: monthKey(new Date()),
  view: "overview",
  loanFilter: "All",
  loanSearch: "",
  sourceFilter: "images",
  selectedDocumentId: null,
  editingLoanId: null,
  selectedLoanId: null,
  detailReturnView: "loans"
};

let initialLoanHash = window.location.hash.match(/^#loan-(.+)$/)?.[1];
let sourceReturnDocumentId = null;

function normalizeLoan(rawLoan) {
  const loan = { ...rawLoan };
  NUMERIC_LOAN_FIELDS.forEach(field => {
    if (loan[field] !== undefined && loan[field] !== null && loan[field] !== "") loan[field] = Number(loan[field]);
  });
  loan.interestOnly = loan.interestOnly === true || loan.interestOnly === 1 || loan.interestOnly === "true";
  loan.autoPay = loan.autoPay === true || loan.autoPay === 1 || loan.autoPay === "true";
  loan.imported = loan.imported !== false && loan.imported !== 0 && loan.imported !== "false";
  return loan;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) showAuthenticatedApp(false);
    const error = new Error(payload.error || payload.message || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return payload.data ?? payload;
}

function paymentMap(rawPayments) {
  if (!Array.isArray(rawPayments)) return rawPayments || {};
  return Object.fromEntries(rawPayments.map(payment => [`${payment.loanId}:${payment.month}`, Boolean(payment.paid)]));
}

function recordMap(rawRecords) {
  if (!Array.isArray(rawRecords)) return rawRecords || {};
  return Object.fromEntries(rawRecords.map(record => [record.loanId || record.loan_id, record.record || record.details || record]));
}

function applyRemoteData(payload) {
  state.loans = (payload.loans || []).map(normalizeLoan);
  state.customLoans = state.loans.filter(loan => !loan.imported);
  state.payments = paymentMap(payload.payments);
  state.settings = { ...DEFAULT_SETTINGS, ...(payload.settings || {}) };
  state.settings.dark = payload.settings?.dark ?? payload.settings?.theme === "dark";
  state.documents = payload.documents || [];
  importedRecords = recordMap(payload.records);
  MONTHLY_INCOME = Number(state.settings.monthlyIncome ?? state.settings.monthly_income ?? 0);
  REPORTED_MONTHLY_OUTFLOW = Number(state.settings.reportedMonthlyOutflow ?? state.settings.reported_monthly_outflow ?? 0);
  document.body.classList.toggle("dark", Boolean(state.settings.dark));

  if (initialLoanHash) {
    const decodedLoanId = decodeURIComponent(initialLoanHash);
    if (state.loans.some(loan => loan.id === decodedLoanId)) {
      state.selectedLoanId = decodedLoanId;
      state.view = "detail";
    }
    initialLoanHash = null;
  }
}

async function persistAction(body) {
  return apiRequest("/api/data", { method: "POST", body: JSON.stringify(body) });
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthIndex(key) {
  const [year, month] = key.split("-").map(Number);
  return year * 12 + month - 1;
}

function shiftMonth(key, amount) {
  const index = monthIndex(key) + amount;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function monthLabel(key, style = "long") {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: style, year: "numeric" }).format(new Date(year, month - 1, 1));
}

function activeInMonth(loan, key) {
  if (loan.interestOnly) return monthIndex(key) >= monthIndex(loan.start);
  return monthIndex(key) >= monthIndex(loan.start) && monthIndex(key) <= monthIndex(loan.end);
}

function loanSnapshot(loan, key) {
  let balance = Number(loan.outstanding);
  const monthlyRate = Number(loan.rate) / 1200;
  const delta = monthIndex(key) - monthIndex(loan.baseMonth || BASE_MONTH);

  if (monthIndex(key) < monthIndex(loan.start)) {
    return { balance: Number(loan.original || loan.outstanding), interest: 0, principal: 0, emi: 0, future: true };
  }

  if (loan.interestOnly && monthIndex(key) > monthIndex(loan.end)) {
    return { balance, interest: 0, principal: 0, emi: 0, matured: true };
  }

  if (!loan.interestOnly && monthIndex(key) > monthIndex(loan.end)) {
    return { balance: 0, interest: 0, principal: 0, emi: 0, completed: true };
  }

  if (!loan.interestOnly && delta > 0) {
    for (let i = 0; i < delta; i += 1) {
      const interest = balance * monthlyRate;
      const principal = Math.max(0, Math.min(balance, Number(loan.emi) - interest));
      balance = Math.max(0, balance - principal);
    }
  } else if (!loan.interestOnly && delta < 0) {
    for (let i = 0; i < Math.abs(delta); i += 1) {
      balance = monthlyRate ? (balance + Number(loan.emi)) / (1 + monthlyRate) : balance + Number(loan.emi);
    }
  }

  const interest = loan.fixedInterest ? Number(loan.fixedInterest) : balance * monthlyRate;
  const emi = Math.min(Number(loan.emi), loan.interestOnly ? Number(loan.emi) : Math.max(0, balance + interest));
  return { balance, interest: Math.min(interest, emi), principal: Math.max(0, emi - interest), emi };
}

function monthData(key) {
  const loans = state.loans.filter(loan => activeInMonth(loan, key)).map(loan => ({ ...loan, snapshot: loanSnapshot(loan, key) }));
  return {
    loans,
    due: loans.reduce((sum, loan) => sum + loan.snapshot.emi, 0),
    interest: loans.reduce((sum, loan) => sum + loan.snapshot.interest, 0),
    outstanding: loans.reduce((sum, loan) => sum + loan.snapshot.balance, 0)
  };
}

function currency(value, decimals = 0) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(value || 0);
}

function compactCurrency(value) {
  if (value >= 10000000) return `₹${(value / 10000000).toFixed(2)}Cr`;
  if (value >= 100000) return `₹${(value / 100000).toFixed(2)}L`;
  if (value >= 1000) return `₹${(value / 1000).toFixed(1)}K`;
  return currency(value);
}

function lenderInfo(lender) {
  if (lenderMeta[lender]) return lenderMeta[lender];
  const palette = ["#527d9b", "#be7662", "#6e72ad", "#63836b"];
  const index = [...lender].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % palette.length;
  return { color: palette[index], logo: lender.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase() };
}

function paidKey(loanId, key) { return `${loanId}:${key}`; }
function paymentLabel(loan) { return loan.interestOnly ? "Monthly interest" : "Monthly EMI"; }
function isPaid(loanId, key) {
  if (state.payments[paidKey(loanId, key)] !== undefined) return state.payments[paidKey(loanId, key)];
  const loan = state.loans.find(item => item.id === loanId);
  if (loan?.paidThrough && monthIndex(key) <= monthIndex(loan.paidThrough)) return true;
  return false;
}

function accountPhase(loan, snapshot = loanSnapshot(loan, state.selectedMonth)) {
  if (snapshot.matured) return { label: "ACTION REQUIRED", className: "attention" };
  if (snapshot.future) return { label: "FUTURE", className: "future" };
  if (snapshot.completed || loan.accountStatus === "Completed") return { label: "COMPLETED", className: "completed" };
  return { label: "ACTIVE", className: "active" };
}

function accountEnding(loan) {
  const value = String(loan.accountNumber || "").replace(/\s/g, "");
  return value ? ` • ${value.slice(-4)}` : "";
}

function dueDateLabel(loan, key = state.selectedMonth) {
  const [year, month] = key.split("-").map(Number);
  const day = Math.min(Number(loan.dueDay), new Date(year, month, 0).getDate());
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(year, month - 1, day));
}

function customLoanRecord(loan) {
  return {
    sourceFiles: [loan.source || "Added manually"],
    sections: [
      { title: "Account identity", fields: [["Loan/account number", loan.accountNumber || "Not provided"], ["Product", loan.category], ["Lender", loan.lender], ["Status", loan.accountStatus || "Active"]] },
      { title: "Contract terms", fields: [["Original amount", currency(loan.original, 2)], ["Contract payment", currency(loan.emi, 2)], ["Interest rate", `${Number(loan.rate).toFixed(2)}% p.a.`], ["Rate type", loan.rateType || "Not provided"], ["Repayment type", loan.interestOnly ? "Interest-only" : "Principal + interest EMI"], ["Tenure", loan.tenureMonths ? `${loan.tenureMonths} months` : "Not provided"], ["Disbursement date", loan.disbursedDate || "Not provided"], ["First payment date", loan.firstDueDate || "Not provided"], ["Maturity date", loan.maturityDate || monthLabel(loan.end, "short")], ["Repayment mode", loan.repaymentMode || "Manual"]] },
      { title: "Imported position", fields: [["Outstanding entered", currency(loan.outstanding, 2)], ["Remaining instalments", loan.remainingInstallments ?? "Not provided"], ["Source position date", loan.sourceAsOf || "Not provided"]] }
    ],
    sourceNote: loan.note || "Values were added manually and saved to the secure workspace."
  };
}

function monthToolbar(title, subtitle) {
  return `<div class="view-toolbar">
    <div><h2>${title}</h2><p class="subtext">${subtitle}</p></div>
    <div class="month-control">
      <button data-action="month-prev" aria-label="Previous month"><svg><use href="#i-left"/></svg></button>
      <strong>${monthLabel(state.selectedMonth, "short")}</strong>
      <button data-action="month-next" aria-label="Next month"><svg><use href="#i-chevron"/></svg></button>
    </div>
  </div>`;
}

function platformData(data) {
  const grouped = {};
  data.loans.forEach(loan => {
    if (!grouped[loan.lender]) grouped[loan.lender] = { name: loan.lender, due: 0, interest: 0, count: 0, color: lenderInfo(loan.lender).color };
    grouped[loan.lender].due += loan.snapshot.emi;
    grouped[loan.lender].interest += loan.snapshot.interest;
    grouped[loan.lender].count += 1;
  });
  return Object.values(grouped).sort((a, b) => b.due - a.due);
}

function buildCashflowChart(startKey, count = 6) {
  const series = Array.from({ length: count }, (_, i) => {
    const key = shiftMonth(startKey, i);
    return { key, ...monthData(key) };
  });
  const width = 640, height = 235, left = 45, right = 12, top = 16, bottom = 28;
  const chartHeight = height - top - bottom;
  const chartWidth = width - left - right;
  const max = Math.max(...series.map(item => item.due), 1) * 1.12;
  const slot = chartWidth / series.length;
  let svg = "";

  for (let i = 0; i <= 4; i += 1) {
    const value = max * (1 - i / 4);
    const y = top + chartHeight * (i / 4);
    svg += `<line class="grid-line" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text x="0" y="${y + 3}">${value >= 100000 ? `${(value / 100000).toFixed(1)}L` : `${Math.round(value / 1000)}k`}</text>`;
  }

  const baseY = top + chartHeight;
  const barWidth = Math.min(count > 6 ? 22 : 36, slot * .48);
  series.forEach((item, i) => {
    const x = left + slot * i + slot / 2 - barWidth / 2;
    const totalHeight = item.due / max * chartHeight;
    const interestHeight = item.interest / max * chartHeight;
    const principalHeight = Math.max(0, totalHeight - interestHeight);
    const label = `${monthLabel(item.key, "short")}: ${currency(item.due)} total, ${currency(item.interest)} interest`;
    svg += `<g class="chart-bar" tabindex="0" role="img" aria-label="${label}" data-tip="${label}">
      <rect x="${x}" y="${baseY - totalHeight}" width="${barWidth}" height="${principalHeight}" rx="3" fill="#0b5c53"/>
      <rect x="${x}" y="${baseY - interestHeight}" width="${barWidth}" height="${interestHeight}" rx="0" fill="#d38a55"/>
      <rect x="${x - 8}" y="${top}" width="${barWidth + 16}" height="${chartHeight}" fill="transparent"/>
      <text x="${x + barWidth / 2}" y="${height - 7}" text-anchor="middle">${monthLabel(item.key, "short").split(" ")[0]}</text>
    </g>`;
  });
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly principal and interest payment chart">${svg}</svg>`;
}

function platformSplit(platforms, total) {
  return `<div class="lender-breakdown">
    <div class="lender-stack" aria-label="Monthly commitment by lender">${platforms.map(platform => `<i style="width:${total ? platform.due / total * 100 : 0}%;background:${platform.color}"></i>`).join("")}</div>
    <div class="platform-list">${platforms.map(platform => `<div class="platform-row">
      <i style="background:${platform.color}"></i><span><strong>${platform.name}</strong><small>${platform.count} ${platform.count === 1 ? "account" : "accounts"} · ${currency(platform.interest)} interest</small></span><strong>${currency(platform.due)}</strong>
      <em>${Math.round(platform.due / total * 100)}%</em>
    </div>`).join("")}</div>
  </div>`;
}

function paymentRow(loan, key, withDate = true) {
  const snapshot = loan.snapshot || loanSnapshot(loan, key);
  const [year, month] = key.split("-").map(Number);
  const maxDay = new Date(year, month, 0).getDate();
  const day = Math.min(loan.dueDay, maxDay);
  const paid = isPaid(loan.id, key);
  const today = new Date();
  const isCurrentMonth = key === monthKey(today);
  const overdue = !paid && isCurrentMonth && day < today.getDate();
  const status = paid ? "PAID" : overdue ? "OVERDUE" : loan.autoPay ? "AUTO-PAY" : "MANUAL";
  return `<div class="payment-row" role="button" tabindex="0" data-loan-id="${loan.id}">
    ${withDate ? `<span class="date-chip"><small>${new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date(year, month - 1, 1))}</small><strong>${day}</strong></span>` : `<span class="lender-logo" style="--logo:${lenderInfo(loan.lender).color}">${lenderInfo(loan.lender).logo}</span>`}
    <span class="payment-info"><strong>${escapeHTML(loan.name)}${loan.interestOnly ? `<em class="type-badge">${snapshot.matured ? "MATURED" : "INTEREST ONLY"}</em>` : ""}</strong><small>${escapeHTML(loan.lender)} • ${currency(snapshot.interest)} interest</small></span>
    <span class="payment-amount"><strong>${currency(snapshot.emi)}</strong><small class="status-${status.toLowerCase()}">${status}</small></span>
  </div>`;
}

function renderOverview() {
  const data = monthData(state.selectedMonth);
  const platforms = platformData(data);
  const autoCount = data.loans.filter(loan => loan.autoPay).length;
  const autoPercent = data.loans.length ? Math.round(autoCount / data.loans.length * 100) : 0;
  const interestPercent = data.due ? data.interest / data.due * 100 : 0;
  const savings = MONTHLY_INCOME - data.due;
  const emiShare = MONTHLY_INCOME > 0 ? Math.min(100, data.due / MONTHLY_INCOME * 100) : 0;
  const savingsShare = Math.max(0, 100 - emiShare);
  const principalThisMonth = data.loans.reduce((sum, loan) => sum + loan.snapshot.principal, 0);
  const goldLoans = data.loans.filter(loan => loan.category === "Gold loan");
  const goldPrincipal = goldLoans.reduce((sum, loan) => sum + Number(loan.original), 0);
  const goldOutstanding = goldLoans.reduce((sum, loan) => sum + loan.snapshot.balance, 0);
  const goldInterest = goldLoans.reduce((sum, loan) => sum + loan.snapshot.interest, 0);
  const goldMatured = goldLoans.some(loan => loan.snapshot.matured);
  const unpaid = data.loans.filter(loan => loan.snapshot.emi > 0 && !isPaid(loan.id, state.selectedMonth));
  const upcoming = [...unpaid].sort((a, b) => a.dueDay - b.dueDay).slice(0, 5);
  const paidTotal = data.loans.filter(loan => isPaid(loan.id, state.selectedMonth)).reduce((sum, loan) => sum + loan.snapshot.emi, 0);
  const displayedDue = Math.round(data.due);
  const displayedPaid = Math.min(displayedDue, Math.round(paidTotal));
  const displayedRemaining = Math.max(0, displayedDue - displayedPaid);
  const nextPayment = upcoming[0];
  const today = new Date();
  const nextIsOverdue = nextPayment && state.selectedMonth === monthKey(today) && nextPayment.dueDay < today.getDate();
  const reconciliationGap = Math.max(0, REPORTED_MONTHLY_OUTFLOW - data.due);

  return `<section class="view">
    ${monthToolbar(`${monthLabel(state.selectedMonth, "long")} overview`, `Based on ${data.loans.filter(loan => loan.snapshot.emi > 0).length} scheduled accounts across ${platforms.length} lenders`)}
    <section class="finance-summary">
      <div class="income-block">
        <span class="section-label">NET MONTHLY INCOME</span>
        <strong>${currency(MONTHLY_INCOME)}</strong>
        <small>Income baseline for your monthly plan</small>
      </div>
      <div class="commitment-block">
        <div><span>Scheduled payments</span><strong>${currency(data.due)}</strong><small>${emiShare.toFixed(1)}% of income</small></div>
        <div><span>Available after payments</span><strong>${currency(Math.max(0, savings))}</strong><small>${savingsShare.toFixed(1)}% remains</small></div>
        <div class="income-meter"><i style="width:${emiShare}%"></i></div>
        <p><span><i></i>Debt payments ${currency(data.due)}</span><span><i></i>Available funds ${currency(Math.max(0, savings))}</span></p>
        <footer><span>Payment status</span><span>Paid <strong>${currency(displayedPaid)}</strong></span><span>Remaining <strong>${currency(displayedRemaining)}</strong></span></footer>
      </div>
    </section>

    <div class="kpi-grid">
      <article class="kpi-card"><span class="kpi-label">Interest cost</span><strong>${currency(data.interest)}</strong><small>${interestPercent.toFixed(1)}% of scheduled payments</small></article>
      <article class="kpi-card"><span class="kpi-label">Principal reduction</span><strong>${currency(principalThisMonth)}</strong><small>Estimated balance paid down</small></article>
      <article class="kpi-card"><span class="kpi-label">Total outstanding</span><strong>${compactCurrency(data.outstanding)}</strong><small>Across ${data.loans.length} tracked accounts</small></article>
      <article class="kpi-card"><span class="kpi-label">${nextIsOverdue ? "Overdue payment" : "Next scheduled payment"}</span><strong>${nextPayment ? currency(nextPayment.snapshot.emi) : "—"}</strong><small>${nextPayment ? `${nextPayment.lender} · ${nextPayment.dueDay} ${monthLabel(state.selectedMonth, "short").split(" ")[0]}` : "Nothing remaining"}</small></article>
    </div>

    ${goldLoans.length ? `<aside class="interest-only-banner ${goldMatured ? "matured" : ""}"><span class="banner-icon"><svg><use href="#i-info"/></svg></span><div><strong>${goldMatured ? "Gold loans require maturity action" : `${goldLoans.length} gold loans are interest-only`}</strong><p>${goldMatured ? `${currency(goldOutstanding)} total outstanding remains. Record renewals or closures to update the plan.` : `${currency(goldInterest)} is collected monthly as interest. Sanctioned principal of ${currency(goldPrincipal)} is not reducing; current total outstanding is ${currency(goldOutstanding)}.`}</p></div><button class="text-button" data-action="view-gold-loans">View gold loans</button></aside>` : ""}
    ${state.selectedMonth === BASE_MONTH && REPORTED_MONTHLY_OUTFLOW > 0 && reconciliationGap > 5000 ? `<aside class="data-gap-banner reconciliation-banner"><span><strong>Reconciliation check</strong><p>Tracked payments total ${currency(data.due)}, which is ${currency(reconciliationGap)} below your reported monthly outflow. Review whether another commitment needs to be added.</p></span><button class="secondary-button" data-action="add-loan">Review and add</button></aside>` : ""}

    <div class="dashboard-grid">
      <div class="stack">
        <article class="panel cashflow-panel">
          <div class="panel-header"><div><h3>Debt payment outlook</h3><p>Principal and interest composition over the next 6 months</p></div><div class="legend"><span><i></i>Principal</span><span><i class="interest"></i>Interest</span></div></div>
          <div class="chart-wrap">${buildCashflowChart(state.selectedMonth, 6)}</div><div class="chart-tooltip"></div>
        </article>
        <article class="panel">
          <div class="panel-header"><div><h3>Commitment by lender</h3><p>Share of this month's scheduled payments</p></div><button class="text-button" data-view-jump="insights">Full analysis</button></div>
          ${platformSplit(platforms, data.due)}
        </article>
      </div>
      <aside class="panel upcoming-panel">
        <div class="panel-header"><div><h3>Upcoming payments</h3><p>Scheduled in ${monthLabel(state.selectedMonth, "long")}</p></div><button class="text-button" data-view-jump="schedule">View all</button></div>
        <div class="payment-list">${upcoming.map(loan => paymentRow(loan, state.selectedMonth)).join("") || `<div class="empty-state">No payments this month</div>`}</div>
      </aside>
    </div>
  </section>`;
}

function renderLoans() {
  const filters = ["All", ...new Set(state.loans.map(loan => loan.lender))];
  const needle = state.loanSearch.toLowerCase();
  const portfolio = state.loans.map(loan => ({ ...loan, snapshot: loanSnapshot(loan, state.selectedMonth) }));
  const loans = portfolio.filter(loan => (state.loanFilter === "All" || loan.lender === state.loanFilter) && (!needle || `${loan.name} ${loan.lender} ${loan.category} ${loan.accountNumber || ""}`.toLowerCase().includes(needle)));
  return `<section class="view">
    ${monthToolbar("Complete loan portfolio", `${state.loans.length} accounts across active, completed and interest-only plans`)}
    <div class="loan-toolbar">
      <div class="search-box"><svg><use href="#i-search"/></svg><input id="loanSearch" value="${escapeHTML(state.loanSearch)}" placeholder="Search loans or lenders" aria-label="Search loans" /></div>
      <label class="mobile-lender-filter"><span>Filter lender</span><select id="mobileLenderFilter" aria-label="Filter loans by lender">${filters.map(filter => `<option value="${escapeHTML(filter)}" ${state.loanFilter === filter ? "selected" : ""}>${escapeHTML(filter)}</option>`).join("")}</select></label>
      <div class="filter-chips">${filters.map(filter => `<button class="filter-chip ${state.loanFilter === filter ? "active" : ""}" data-filter="${escapeHTML(filter)}">${filter}</button>`).join("")}</div>
    </div>
    <article class="panel loans-panel">
      <div class="loan-table-head"><span>Account / lender</span><span>Monthly payment</span><span>Interest</span><span>Rate</span><span>Outstanding</span><span></span></div>
      <div id="loanRows">${loanRows(loans)}</div>
    </article>
  </section>`;
}

function loanRows(loans) {
  if (!loans.length) return `<div class="empty-state">No loans match this view.</div>`;
  return loans.map(loan => {
    const meta = lenderInfo(loan.lender);
    const phase = accountPhase(loan, loan.snapshot);
    return `<div class="loan-row" role="button" tabindex="0" data-loan-id="${loan.id}">
      <div class="loan-name"><span class="lender-logo" style="--logo:${meta.color}">${meta.logo}</span><span><strong>${escapeHTML(loan.name)}${loan.interestOnly ? `<em class="type-badge">INTEREST ONLY</em>` : ""}</strong><small>${escapeHTML(loan.lender)}${accountEnding(loan)} • ${escapeHTML(loan.category)} <em class="account-phase ${phase.className}">${phase.label}</em></small></span></div>
      <div class="loan-cell"><strong>${currency(loan.snapshot.emi)}</strong><small>${loan.snapshot.completed ? "No payment · completed" : loan.snapshot.future ? "Not started" : `${paymentLabel(loan)} · day ${loan.dueDay}`}</small></div>
      <div class="loan-cell"><strong>${currency(loan.snapshot.interest)}</strong><small>${loan.interestOnly ? "principal unchanged" : loan.rate ? "estimated this month" : "no monthly interest"}</small></div>
      <div class="loan-cell"><span class="rate-pill ${loan.rate === 0 ? "zero" : ""}">${loan.rate.toFixed(2)}%</span></div>
      <div class="loan-cell"><strong>${currency(loan.snapshot.balance)}</strong><small>${loan.interestOnly ? "balloon principal" : "estimated balance"}</small></div>
      <svg><use href="#i-chevron"/></svg>
    </div>`;
  }).join("");
}

function renderLoanDetail() {
  const loan = state.loans.find(item => item.id === state.selectedLoanId);
  if (!loan) return `<section class="view"><div class="empty-state">This account could not be found.</div></section>`;
  const snapshot = loanSnapshot(loan, state.selectedMonth);
  const record = importedRecords[loan.id] || customLoanRecord(loan);
  const meta = lenderInfo(loan.lender);
  const phase = accountPhase(loan, snapshot);
  const paid = snapshot.emi > 0 && isPaid(loan.id, state.selectedMonth);
  const isCustom = state.customLoans.some(item => item.id === loan.id);
  const paymentStatus = snapshot.completed ? "Completed" : snapshot.future ? "Not started" : snapshot.matured ? "Maturity action required" : paid ? "Paid" : "Not marked paid";
  const sourceMonth = loan.sourceAsOf ? loan.sourceAsOf : "Not provided";
  const terms = record.sections.map(section => `<article class="panel entity-section">
    <div class="panel-header"><div><h3>${escapeHTML(section.title)}</h3></div></div>
    <dl class="fact-grid">${section.fields.map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join("")}</dl>
  </article>`).join("");
  const history = record.history?.length ? `<article class="panel entity-section entity-history">
    <div class="panel-header"><div><h3>Verified payment history</h3><p>Transactions visible in the supplied source</p></div></div>
    <div class="history-list">${record.history.map(([date, amount, status, note]) => `<div class="history-row"><span><strong>${escapeHTML(date)}</strong><small>${escapeHTML(note)}</small></span><span><strong>${escapeHTML(amount)}</strong><small>${escapeHTML(status)}</small></span></div>`).join("")}</div>
  </article>` : "";

  return `<section class="view entity-detail-view">
    <div class="entity-backbar">
      <button class="secondary-button back-account" data-action="back-detail"><svg><use href="#i-left"/></svg>Back to portfolio</button>
      <span>Viewing ${monthLabel(state.selectedMonth, "long")}</span>
    </div>
    <header class="entity-header" style="--entity-color:${meta.color}">
      <span class="lender-logo">${meta.logo}</span>
      <div><p>${escapeHTML(loan.lender)} · ${escapeHTML(loan.category)}</p><h2>${escapeHTML(loan.name)}</h2><small>${loan.accountNumber ? `Account ${escapeHTML(loan.accountNumber)}` : "Account number not available in source"}</small></div>
      <span class="entity-status ${phase.className}">${phase.label}</span>
    </header>

    ${loan.interestOnly ? `<aside class="entity-callout ${snapshot.matured ? "matured" : ""}"><svg><use href="#i-info"/></svg><span><strong>${snapshot.matured ? "Maturity action is required" : "Interest-only repayment"}</strong><small>${snapshot.matured ? `${currency(snapshot.balance, 2)} total outstanding remains after maturity.` : `${currency(snapshot.emi, 2)} is the monthly interest collection. Principal reduction is ₹0.00; the sanctioned principal of ${currency(loan.original, 2)} remains separately payable.`}</small></span></aside>` : ""}
    ${loan.scheduleEstimated ? `<aside class="entity-disclosure"><strong>Schedule disclosure</strong><span>The source confirms the account values but does not show every recurring due date. Unshown schedule dates are tracker estimates.</span></aside>` : ""}

    <article class="panel entity-month-card">
      <div class="panel-header"><div><h3>This month's position</h3><p>${monthLabel(state.selectedMonth, "long")} · due ${dueDateLabel(loan)}</p></div><span class="month-status ${paid ? "paid" : ""}">${paymentStatus}</span></div>
      <div class="entity-metrics">
        <div><small>${paymentLabel(loan)}</small><strong>${currency(snapshot.emi, 2)}</strong></div>
        <div><small>Interest this month</small><strong>${currency(snapshot.interest, 2)}</strong></div>
        <div><small>Principal reduction</small><strong>${currency(snapshot.principal, 2)}</strong></div>
        <div><small>${loan.interestOnly ? "Current total outstanding" : "Estimated outstanding"}</small><strong>${currency(snapshot.balance, 2)}</strong></div>
      </div>
      <div class="composition-row"><span style="--principal:${snapshot.emi ? Math.max(0, snapshot.principal / snapshot.emi * 100) : 0}%"></span><p><b>Payment composition</b><em>${currency(snapshot.principal, 2)} principal</em><em>${currency(snapshot.interest, 2)} interest</em></p></div>
    </article>

    <div class="entity-sections">${terms}</div>
    ${history}
    <article class="panel source-card">
      <div class="source-verified"><svg><use href="#i-check"/></svg><span><strong>Source-verified record</strong><small>Position dated ${escapeHTML(sourceMonth)} · ${record.sourceFiles.length} source ${record.sourceFiles.length === 1 ? "file" : "files"}</small></span></div>
      <div class="source-files">${record.sourceFiles.map(file => `<span>${escapeHTML(file)}</span>`).join("")}</div>
      <p>${escapeHTML(record.sourceNote)}</p>
    </article>
    <div class="entity-actions">${isCustom ? `<button class="secondary-button danger-button" data-delete-loan="${loan.id}">Delete</button><button class="secondary-button" data-edit-loan="${loan.id}">Edit details</button>` : ""}${snapshot.emi > 0 ? `<button class="primary-button" data-toggle-paid="${loan.id}"><svg><use href="#i-check"/></svg>${paid ? "Mark unpaid" : `Mark ${monthLabel(state.selectedMonth, "short").split(" ")[0]} paid`}</button>` : ""}</div>
  </section>`;
}

function renderInsights() {
  const data = monthData(state.selectedMonth);
  const platforms = platformData(data);
  const highest = [...data.loans].sort((a, b) => b.snapshot.interest - a.snapshot.interest)[0];
  const zeroInterest = data.loans.filter(loan => loan.rate === 0).length;
  const maxInterest = Math.max(...data.loans.map(loan => loan.snapshot.interest), 1);
  return `<section class="view">
    ${monthToolbar("Interest & cash-flow insights", "Understand the true monthly cost of your borrowing")}
    <div class="insight-summary">
      <article class="panel mini-stat"><small>Monthly outflow</small><strong>${currency(data.due)}</strong><em>${data.loans.length} active payments</em></article>
      <article class="panel mini-stat"><small>Interest cost</small><strong>${currency(data.interest)}</strong><em>${data.due ? (data.interest / data.due * 100).toFixed(1) : "0.0"}% of this month's due</em></article>
      <article class="panel mini-stat"><small>Highest interest loan</small><strong>${highest ? currency(highest.snapshot.interest) : "—"}</strong><em>${highest?.name || "No active loans"}</em></article>
      <article class="panel mini-stat"><small>Zero monthly-interest plans</small><strong>${zeroInterest}</strong><em>Upfront fees may still apply</em></article>
    </div>
    <div class="insights-grid">
      <article class="panel cashflow-panel">
        <div class="panel-header"><div><h3>12-month debt outlook</h3><p>Principal and interest composition as plans finish</p></div><div class="legend"><span><i></i>Principal</span><span><i class="interest"></i>Interest</span></div></div>
        <div class="chart-wrap chart-wide">${buildCashflowChart(state.selectedMonth, 12)}</div><div class="chart-tooltip"></div>
      </article>
      <article class="panel">
        <div class="panel-header"><div><h3>Interest by loan</h3><p>Estimated monthly finance cost</p></div></div>
        <div class="interest-bars">${[...data.loans].sort((a,b) => b.snapshot.interest - a.snapshot.interest).slice(0, 7).map((loan, index) => `<div>
          <div class="interest-bar-head"><span>${loan.name}</span><strong>${currency(loan.snapshot.interest)}</strong></div>
          <div class="bar-track"><i style="width:${loan.snapshot.interest / maxInterest * 100}%;--bar:${index === 0 ? "#ee8b61" : lenderInfo(loan.lender).color}"></i></div>
        </div>`).join("")}</div>
      </article>
      <article class="panel">
        <div class="panel-header"><div><h3>Lender allocation</h3><p>Share of your monthly payment</p></div></div>
        ${platformSplit(platforms, data.due)}
      </article>
      <article class="panel">
        <div class="panel-header"><div><h3>Reading the estimate</h3><p>How monthly interest is calculated</p></div></div>
        <div class="detail-note"><svg><use href="#i-info"/></svg><span>For rate-based loans, EMI TRACKER applies the annual rate to the latest outstanding balance and rolls the amortisation forward each month. Exact lender splits can differ slightly because of posting dates, daily interest and fees.</span></div>
      </article>
    </div>
  </section>`;
}

function renderCalendar(key, loans) {
  const [year, month] = key.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const days = new Date(year, month, 0).getDate();
  const previousDays = new Date(year, month - 1, 0).getDate();
  const mondayOffset = (first.getDay() + 6) % 7;
  const dueDays = new Set(loans.map(loan => Math.min(loan.dueDay, days)));
  const today = new Date();
  let cells = "";
  for (let i = mondayOffset - 1; i >= 0; i -= 1) cells += `<button class="muted">${previousDays - i}</button>`;
  for (let day = 1; day <= days; day += 1) {
    const isToday = today.getFullYear() === year && today.getMonth() === month - 1 && today.getDate() === day;
    cells += `<button class="${dueDays.has(day) ? "has-due" : ""} ${isToday ? "today" : ""}">${day}</button>`;
  }
  let trailing = 1;
  while ((mondayOffset + days + trailing - 1) % 7 !== 0) cells += `<button class="muted">${trailing++}</button>`;
  return `<article class="panel calendar-panel"><div class="calendar-head"><h3>${monthLabel(key, "long")}</h3><svg><use href="#i-calendar"/></svg></div><div class="calendar-week"><span>MO</span><span>TU</span><span>WE</span><span>TH</span><span>FR</span><span>SA</span><span>SU</span></div><div class="calendar-days">${cells}</div></article>`;
}

function renderSchedule() {
  const data = monthData(state.selectedMonth);
  const groups = {};
  [...data.loans].filter(loan => loan.snapshot.emi > 0).sort((a,b) => a.dueDay - b.dueDay).forEach(loan => {
    const key = loan.dueDay;
    if (!groups[key]) groups[key] = [];
    groups[key].push(loan);
  });
  const [year, month] = state.selectedMonth.split("-").map(Number);
  const schedule = Object.entries(groups).map(([day, loans]) => {
    const label = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long" }).format(new Date(year, month - 1, Math.min(Number(day), new Date(year, month, 0).getDate())));
    return `<section class="schedule-date-group"><h3>${label} • ${loans.length} payment${loans.length > 1 ? "s" : ""}</h3>${loans.map(loan => paymentRow(loan, state.selectedMonth, false)).join("")}</section>`;
  }).join("");
  return `<section class="view">
    ${monthToolbar("Monthly payment schedule", "Automatically generated from active loan date ranges")}
    <div class="schedule-layout">${renderCalendar(state.selectedMonth, data.loans)}<article class="panel schedule-list">${schedule || `<div class="empty-state">Nothing scheduled for ${monthLabel(state.selectedMonth)}</div>`}</article></div>
  </section>`;
}

function renderSettings() {
  const sourceCount = state.documents.length;
  const screenshotCount = state.documents.filter(document => String(document.contentType || "").startsWith("image/")).length;
  const statementCount = state.documents.filter(document => document.contentType === "application/pdf").length;
  return `<section class="view">
    <div class="view-toolbar"><div><h2>Settings & data</h2><p class="subtext">Manage appearance, exports and secure data</p></div></div>
    <div class="settings-grid">
      <article class="panel settings-card">
        <div class="panel-header"><div><h3>Plan preferences</h3><p>How your workspace presents the portfolio</p></div></div>
        <div class="setting-row"><span><strong>Monthly schedule</strong><small>Generated automatically from each account's date range</small></span><span class="rate-pill zero">AUTOMATIC</span></div>
        <div class="setting-row"><span><strong>Income baseline</strong><small>Used only to calculate available funds after debt payments</small></span><strong>${currency(MONTHLY_INCOME)}</strong></div>
        <div class="setting-row"><span><strong>Dark appearance</strong><small>Use a low-light colour theme</small></span><button class="toggle ${state.settings.dark ? "on" : ""}" role="switch" aria-checked="${state.settings.dark}" data-setting="dark" aria-label="Toggle dark appearance"></button></div>
      </article>
      <article class="panel settings-card">
        <div class="panel-header"><div><h3>Data & privacy</h3><p>Protected by your private account</p></div></div>
        <div class="setting-row"><span class="data-source"><i></i><span><strong>${sourceCount} source files reconciled</strong><small>${statementCount} statements + ${screenshotCount} screenshots · ${state.loans.length} tracked accounts</small></span></span><span class="rate-pill zero">VERIFIED</span></div>
        <div class="setting-row"><span><strong>Export monthly schedule</strong><small>Download all tracked loans as a CSV file</small></span><button class="secondary-button" data-action="export"><svg><use href="#i-download"/></svg>Export</button></div>
        <div class="setting-row"><span><strong>Secure database</strong><small>Loans, payment status and preferences sync after sign-in</small></span><span class="rate-pill zero">SYNCED</span></div>
      </article>
    </div>
  </section>`;
}

function fileSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceDocumentUrl(document, inline = false) {
  const base = document.contentUrl || `/api/documents/${encodeURIComponent(document.id)}`;
  return inline ? `${base}${base.includes("?") ? "&" : "?"}inline=1` : base;
}

function renderSources() {
  const documents = state.documents || [];
  const images = documents.filter(document => String(document.contentType || "").startsWith("image/"));
  const statements = documents.filter(document => document.contentType === "application/pdf");
  const selected = documents.find(document => document.id === state.selectedDocumentId);

  if (selected) {
    const isImage = String(selected.contentType || "").startsWith("image/");
    const previewUrl = sourceDocumentUrl(selected, true);
    return `<section class="view sources-view">
      <div class="source-viewer">
        <div class="source-viewer-backdrop" data-action="back-sources" aria-hidden="true"></div>
        <article class="source-viewer-panel" role="dialog" aria-modal="true" aria-labelledby="sourceViewerTitle">
          ${isImage
            ? `<div class="source-viewer-image"><img src="${escapeHTML(previewUrl)}" alt="Raw uploaded source: ${escapeHTML(selected.filename)}" /></div>`
            : `<div class="source-viewer-image source-document-preview"><iframe src="${escapeHTML(previewUrl)}" title="${escapeHTML(selected.filename)}"></iframe></div>`}
          <aside class="source-viewer-details">
            <button class="icon-button" data-action="back-sources" aria-label="Close source preview"><svg><use href="#i-close"/></svg></button>
            <p class="eyebrow">PRIVATE ORIGINAL</p><h2 id="sourceViewerTitle">${escapeHTML(selected.filename)}</h2>
            <p>This is the raw uploaded file used during portfolio reconciliation.</p>
            <dl><div><dt>File type</dt><dd>${isImage ? "Screenshot" : "Statement"}</dd></div><div><dt>File size</dt><dd>${fileSize(selected.byteSize)}</dd></div><div><dt>Integrity</dt><dd>SHA-256 verified</dd></div><div><dt>Storage</dt><dd>Private Vercel Blob</dd></div></dl>
            <a class="secondary-button source-download" href="${escapeHTML(sourceDocumentUrl(selected))}" download><svg><use href="#i-download"/></svg>Download original</a>
          </aside>
        </article>
      </div>
    </section>`;
  }

  const filtered = state.sourceFilter === "images" ? images : state.sourceFilter === "statements" ? statements : documents;
  return `<section class="view sources-view">
    <div class="view-toolbar"><div><h2>Source files</h2><p class="subtext">Private originals used to reconcile your portfolio</p></div></div>
    <div class="source-summary">
      <span><small>Verified originals</small><strong>${documents.length}</strong></span>
      <span><small>Raw screenshots</small><strong>${images.length}</strong></span>
      <span><small>Statements</small><strong>${statements.length}</strong></span>
      <p><svg><use href="#i-lock"/></svg>Stored privately in Vercel Cloud. Every preview is served only after authentication.</p>
    </div>
    <div class="source-filterbar" role="group" aria-label="Filter source files">
      <button class="${state.sourceFilter === "images" ? "active" : ""}" data-source-filter="images">Screenshots <span>${images.length}</span></button>
      <button class="${state.sourceFilter === "statements" ? "active" : ""}" data-source-filter="statements">Statements <span>${statements.length}</span></button>
      <button class="${state.sourceFilter === "all" ? "active" : ""}" data-source-filter="all">All files <span>${documents.length}</span></button>
    </div>
    ${filtered.length ? `<div class="source-grid">${filtered.map(document => {
      const isImage = String(document.contentType || "").startsWith("image/");
      return `<button class="source-card" data-source-id="${escapeHTML(document.id)}" aria-label="View ${escapeHTML(document.filename)}">
        <span class="source-thumb">${isImage ? `<img loading="lazy" src="${escapeHTML(sourceDocumentUrl(document, true))}" alt="" />` : `<svg><use href="#i-file-image"/></svg><em>PDF</em>`}</span>
        <span class="source-meta"><span><strong>${escapeHTML(document.filename)}</strong><small>${fileSize(document.byteSize)} · SHA-256 verified</small></span><em class="source-type ${isImage ? "image" : "pdf"}">${isImage ? "SCREENSHOT" : "STATEMENT"}</em></span>
      </button>`;
    }).join("")}</div>` : `<div class="source-empty"><svg><use href="#i-file-image"/></svg><strong>No source files in this view</strong><p>Choose another filter to review the imported originals.</p></div>`}
  </section>`;
}

const viewRoot = document.getElementById("viewRoot");
const titles = {
  overview: ["FINANCES", "Overview"], loans: ["PORTFOLIO", "Loans"],
  insights: ["ANALYTICS", "Insights"], schedule: ["PAYMENTS", "Schedule"], settings: ["ACCOUNT", "Settings"], sources: ["EVIDENCE", "Source files"],
  detail: ["ACCOUNT", "Loan details"]
};

function render() {
  const renders = { overview: renderOverview, loans: renderLoans, insights: renderInsights, schedule: renderSchedule, settings: renderSettings, sources: renderSources, detail: renderLoanDetail };
  document.body.classList.toggle("detail-mode", state.view === "detail");
  document.body.classList.toggle("source-viewer-open", state.view === "sources" && Boolean(state.selectedDocumentId));
  viewRoot.innerHTML = renders[state.view]();
  document.getElementById("pageEyebrow").textContent = titles[state.view][0];
  document.getElementById("pageTitle").textContent = titles[state.view][1];
  document.getElementById("loanCountBadge").textContent = state.loans.length;
  const activeView = state.view === "detail" ? state.detailReturnView : state.view;
  document.querySelectorAll("[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === activeView));
  attachChartTips();
}

function setView(view) {
  if (!titles[view]) return;
  if (state.view === "detail" && view !== "detail") {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    state.selectedLoanId = null;
  }
  state.view = view;
  if (view !== "sources") state.selectedDocumentId = null;
  window.scrollTo({ top: 0, behavior: "smooth" });
  render();
}

function focusSourceViewer() {
  requestAnimationFrame(() => document.querySelector(".source-viewer-details .icon-button")?.focus());
}

function closeSourceViewer() {
  const returnDocumentId = sourceReturnDocumentId || state.selectedDocumentId;
  state.selectedDocumentId = null;
  render();
  requestAnimationFrame(() => {
    if (!returnDocumentId) return;
    document.querySelector(`[data-source-id="${returnDocumentId}"]`)?.focus();
  });
}

function attachChartTips() {
  document.querySelectorAll(".cashflow-panel").forEach(panel => {
    const tip = panel.querySelector(".chart-tooltip");
    panel.querySelectorAll(".chart-bar").forEach(bar => {
      const showFocusedTip = () => {
        const bounds = panel.getBoundingClientRect();
        const barBounds = bar.getBoundingClientRect();
        tip.textContent = bar.dataset.tip;
        tip.style.left = `${barBounds.left + barBounds.width / 2 - bounds.left}px`;
        tip.style.top = `${barBounds.top - bounds.top + 12}px`;
        tip.style.opacity = "1";
      };
      bar.addEventListener("mouseenter", event => {
        const bounds = panel.getBoundingClientRect();
        tip.textContent = bar.dataset.tip;
        tip.style.left = `${event.clientX - bounds.left}px`;
        tip.style.top = `${event.clientY - bounds.top}px`;
        tip.style.opacity = "1";
      });
      bar.addEventListener("mousemove", event => {
        const bounds = panel.getBoundingClientRect();
        tip.style.left = `${event.clientX - bounds.left}px`;
        tip.style.top = `${event.clientY - bounds.top}px`;
      });
      bar.addEventListener("mouseleave", () => { tip.style.opacity = "0"; });
      bar.addEventListener("focus", showFocusedTip);
      bar.addEventListener("blur", () => { tip.style.opacity = "0"; });
      bar.addEventListener("click", showFocusedTip);
    });
  });
}

function showLoanDetails(id) {
  const loan = state.loans.find(item => item.id === id);
  if (!loan) return;
  state.detailReturnView = state.view === "detail" ? state.detailReturnView : state.view;
  state.selectedLoanId = id;
  state.view = "detail";
  window.history.pushState({ emiTrackerDetail: id }, "", `#loan-${encodeURIComponent(id)}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
  render();
}

function openLoanDialog(loanId = null) {
  const dialog = document.getElementById("loanDialog");
  const form = document.getElementById("loanForm");
  form.reset(); state.editingLoanId = typeof loanId === "string" ? loanId : null;
  const loan = state.editingLoanId ? state.customLoans.find(item => item.id === state.editingLoanId) : null;
  document.getElementById("loanDialogTitle").textContent = loan ? "Edit loan" : "Add a loan";
  document.getElementById("loanSubmitLabel").textContent = loan ? "Save changes" : "Add to tracker";
  if (loan) {
    form.elements.name.value = loan.name; form.elements.lender.value = loan.lender; form.elements.category.value = loan.category;
    form.elements.accountNumber.value = loan.accountNumber || "";
    form.elements.repaymentType.value = loan.interestOnly ? "interest_only" : "amortizing";
    form.elements.emi.value = loan.emi; form.elements.rate.value = loan.rate; form.elements.outstanding.value = loan.outstanding;
    form.elements.original.value = loan.original || "";
    form.elements.dueDay.value = loan.dueDay; form.elements.start.value = loan.start; form.elements.end.value = loan.end;
    form.elements.tenureMonths.value = loan.tenureMonths || ""; form.elements.remainingInstallments.value = loan.remainingInstallments ?? "";
    form.elements.rateType.value = loan.rateType || ""; form.elements.repaymentMode.value = loan.repaymentMode || "";
    form.elements.disbursedDate.value = loan.disbursedDate || ""; form.elements.firstDueDate.value = loan.firstDueDate || "";
    form.elements.maturityDate.value = loan.maturityDate || ""; form.elements.sourceAsOf.value = loan.sourceAsOf || "";
    form.elements.note.value = loan.note || "";
  } else {
    form.elements.start.value = state.selectedMonth;
    form.elements.end.value = shiftMonth(state.selectedMonth, 11);
  }
  dialog.showModal();
}

function openGoldLoanDialog() {
  openLoanDialog();
  const form = document.getElementById("loanForm");
  const usedNumbers = new Set(state.loans.filter(loan => loan.category === "Gold loan").map(loan => Number(loan.name.match(/\d+/)?.[0])).filter(Boolean));
  const nextNumber = usedNumbers.size ? Math.max(...usedNumbers) + 1 : 1;
  const existingGoldLender = state.loans.find(loan => loan.category === "Gold loan")?.lender || "";
  form.elements.name.value = `Gold loan ${nextNumber}`;
  form.elements.lender.value = existingGoldLender;
  form.elements.category.value = "Gold loan";
  form.elements.repaymentType.value = "interest_only";
}

async function addLoan(form) {
  const data = new FormData(form);
  const cleanText = value => String(value).replace(/<[^>]*>/g, "").replace(/[<>]/g, "").trim();
  const lender = cleanText(data.get("lender"));
  const existing = state.editingLoanId ? state.customLoans.find(item => item.id === state.editingLoanId) : null;
  const start = data.get("start");
  const outstanding = Number(data.get("outstanding"));
  const original = Number(data.get("original")) || outstanding;
  const loan = {
    id: existing?.id || `custom-${Date.now()}`, name: cleanText(data.get("name")), lender, category: data.get("category"),
    accountNumber: cleanText(data.get("accountNumber")), original, outstanding, emi: Number(data.get("emi")), rate: Number(data.get("rate")), dueDay: Number(data.get("dueDay")),
    start, end: data.get("end"), baseMonth: monthIndex(start) > monthIndex(state.selectedMonth) ? start : state.selectedMonth, autoPay: false,
    repaymentType: data.get("repaymentType"), interestOnly: data.get("repaymentType") === "interest_only",
    tenureMonths: Number(data.get("tenureMonths")) || null, remainingInstallments: data.get("remainingInstallments") === "" ? null : Number(data.get("remainingInstallments")),
    rateType: cleanText(data.get("rateType")), repaymentMode: cleanText(data.get("repaymentMode")),
    disbursedDate: data.get("disbursedDate"), firstDueDate: data.get("firstDueDate"), maturityDate: data.get("maturityDate"), sourceAsOf: data.get("sourceAsOf"),
    accountStatus: "Active", source: "Added manually", note: cleanText(data.get("note")) || (data.get("repaymentType") === "interest_only" ? "Interest-only facility: monthly payments do not reduce principal." : "Interest is estimated from the balance and rate you entered.")
  };
  loan.imported = false;
  if (loan.interestOnly) loan.fixedInterest = loan.emi;
  if (monthIndex(loan.end) < monthIndex(loan.start)) { showToast("End month must be after start month"); return; }
  const submitButton = form.querySelector("[type='submit']");
  submitButton.disabled = true;
  try {
    await persistAction({ action: "upsertLoan", loan, record: customLoanRecord(loan) });
  } catch (error) {
    showToast(error.message || "Loan could not be saved");
    submitButton.disabled = false;
    return;
  }
  if (existing) {
    state.customLoans = state.customLoans.map(item => item.id === loan.id ? loan : item);
    state.loans = state.loans.map(item => item.id === loan.id ? loan : item);
  } else {
    state.customLoans.push(loan); state.loans.push(loan);
  }
  state.editingLoanId = null;
  importedRecords[loan.id] = customLoanRecord(loan);
  submitButton.disabled = false;
  document.getElementById("loanDialog").close(); form.reset(); render(); showToast(existing ? "Loan updated" : "Loan added to your tracker");
}

function exportCSV() {
  const rows = [["Month", "Lender", "Loan", "Account number", "Category", "Account phase", "Payment type", "Payment status", "Monthly payment", "Interest", "Principal", "Outstanding", "Original amount", "Rate", "Rate type", "Due day", "Original tenure", "Remaining instalments", "Disbursed date", "First due date", "Maturity date", "Source position date", "Schedule basis", "Source"]];
  state.loans.filter(loan => activeInMonth(loan, state.selectedMonth)).forEach(loan => {
    const snapshot = loanSnapshot(loan, state.selectedMonth);
    rows.push([state.selectedMonth, loan.lender, loan.name, loan.accountNumber || "Not provided", loan.category, accountPhase(loan, snapshot).label, loan.interestOnly ? "Interest-only" : "Amortizing EMI", isPaid(loan.id, state.selectedMonth) ? "Paid" : "Unpaid", snapshot.emi.toFixed(2), snapshot.interest.toFixed(2), snapshot.principal.toFixed(2), snapshot.balance.toFixed(2), Number(loan.original).toFixed(2), loan.rate.toFixed(2), loan.rateType || "Not provided", loan.dueDay, loan.tenureMonths || "Not provided", loan.remainingInstallments ?? "Not provided", loan.disbursedDate || "Not provided", loan.firstDueDate || "Not provided", loan.maturityDate || "Not provided", loan.sourceAsOf || "Not provided", loan.scheduleEstimated ? "Estimated where source is silent" : "Source-confirmed", loan.source]);
  });
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a"); link.href = url; link.download = `emi-tracker-${state.selectedMonth}.csv`; link.click(); URL.revokeObjectURL(url);
  showToast("Monthly schedule exported");
}

function showToast(message) {
  const toast = document.getElementById("toast"); toast.querySelector("span").textContent = message; toast.classList.add("show");
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), 2300);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

document.addEventListener("click", async event => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) { setView(viewButton.dataset.view); return; }
  const link = event.target.closest("[data-view-link]");
  if (link) { event.preventDefault(); setView(link.dataset.viewLink); return; }
  const jump = event.target.closest("[data-view-jump]");
  if (jump) { setView(jump.dataset.viewJump); return; }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "month-prev" || action === "month-next") { state.selectedMonth = shiftMonth(state.selectedMonth, action === "month-prev" ? -1 : 1); render(); return; }
  if (action === "back-detail") {
    if (window.history.state?.emiTrackerDetail) window.history.back();
    else { state.view = state.detailReturnView || "loans"; state.selectedLoanId = null; render(); }
    return;
  }
  if (action === "add-loan") { openLoanDialog(); return; }
  if (action === "add-gold-loan") { openGoldLoanDialog(); return; }
  if (action === "view-gold-loans") { state.loanFilter = "All"; state.loanSearch = "Gold loan"; setView("loans"); return; }
  if (action === "export") { exportCSV(); return; }
  if (action === "back-sources") { closeSourceViewer(); return; }
  const sourceCard = event.target.closest("[data-source-id]");
  if (sourceCard) {
    sourceReturnDocumentId = sourceCard.dataset.sourceId;
    state.selectedDocumentId = sourceCard.dataset.sourceId;
    render(); focusSourceViewer();
    return;
  }
  const sourceFilter = event.target.closest("[data-source-filter]");
  if (sourceFilter) { state.sourceFilter = sourceFilter.dataset.sourceFilter; render(); return; }
  const paidButton = event.target.closest("[data-toggle-paid]");
  if (paidButton) {
    const loan = state.loans.find(item => item.id === paidButton.dataset.togglePaid);
    if (!loan) return;
    const wasPaid = isPaid(loan.id, state.selectedMonth);
    state.payments[paidKey(loan.id, state.selectedMonth)] = !wasPaid;
    render();
    try {
      await persistAction({ action: "setPayment", loanId: loan.id, month: state.selectedMonth, paid: !wasPaid });
      showToast(wasPaid ? "Payment marked as unpaid" : "Payment marked as paid");
    } catch (error) {
      state.payments[paidKey(loan.id, state.selectedMonth)] = wasPaid;
      render(); showToast(error.message || "Payment status could not be saved");
    }
    return;
  }
  const editButton = event.target.closest("[data-edit-loan]");
  if (editButton) { openLoanDialog(editButton.dataset.editLoan); return; }
  const deleteButton = event.target.closest("[data-delete-loan]");
  if (deleteButton) {
    const loan = state.customLoans.find(item => item.id === deleteButton.dataset.deleteLoan);
    if (!loan || !window.confirm(`Delete ${loan.name}?`)) return;
    try {
      await persistAction({ action: "deleteLoan", loanId: loan.id });
    } catch (error) {
      showToast(error.message || "Loan could not be deleted"); return;
    }
    state.customLoans = state.customLoans.filter(item => item.id !== loan.id);
    state.loans = state.loans.filter(item => item.id !== loan.id);
    delete importedRecords[loan.id];
    state.selectedLoanId = null; state.view = "loans"; render(); showToast("Loan deleted"); return;
  }
  const row = event.target.closest("[data-loan-id]");
  if (row) { showLoanDetails(row.dataset.loanId); return; }
  const filter = event.target.closest("[data-filter]");
  if (filter) { state.loanFilter = filter.dataset.filter; render(); return; }
  const setting = event.target.closest("[data-setting]");
  if (setting) {
    const key = setting.dataset.setting;
    const oldValue = state.settings[key];
    state.settings[key] = !state.settings[key];
    if (key === "dark") document.body.classList.toggle("dark", state.settings.dark);
    render();
    try {
      await persistAction({ action: "updateSettings", settings: state.settings });
      showToast("Preference updated");
    } catch (error) {
      state.settings[key] = oldValue;
      if (key === "dark") document.body.classList.toggle("dark", state.settings.dark);
      render(); showToast(error.message || "Preference could not be saved");
    }
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && state.selectedDocumentId) {
    event.preventDefault(); closeSourceViewer(); return;
  }
  if (event.key === "Tab" && state.selectedDocumentId) {
    const panel = document.querySelector(".source-viewer-panel");
    if (!panel) return;
    const focusable = [...panel.querySelectorAll("button, a[href], iframe, [tabindex]:not([tabindex='-1'])")]
      .filter(element => !element.hidden && element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!panel.contains(document.activeElement)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("[data-loan-id][role='button']");
  if (!row) return;
  event.preventDefault(); showLoanDetails(row.dataset.loanId);
});

viewRoot.addEventListener("input", event => {
  if (event.target.id !== "loanSearch") return;
  state.loanSearch = event.target.value;
  const needle = state.loanSearch.toLowerCase();
  const loans = state.loans.map(loan => ({ ...loan, snapshot: loanSnapshot(loan, state.selectedMonth) })).filter(loan => (state.loanFilter === "All" || loan.lender === state.loanFilter) && (!needle || `${loan.name} ${loan.lender} ${loan.category} ${loan.accountNumber || ""}`.toLowerCase().includes(needle)));
  document.getElementById("loanRows").innerHTML = loanRows(loans);
});

viewRoot.addEventListener("change", event => {
  if (event.target.id !== "mobileLenderFilter") return;
  state.loanFilter = event.target.value;
  render();
});

document.getElementById("addLoanButton").addEventListener("click", () => openLoanDialog());
document.querySelectorAll("#loanForm [value='cancel']").forEach(button => button.addEventListener("click", event => { event.preventDefault(); document.getElementById("loanDialog").close(); }));
document.getElementById("loanForm").addEventListener("submit", async event => { event.preventDefault(); if (event.submitter?.value === "cancel") return; await addLoan(event.currentTarget); });

const authGate = document.getElementById("authGate");
const appShell = document.getElementById("appShell");
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");

function showAuthenticatedApp(authenticated) {
  authGate.hidden = authenticated;
  appShell.hidden = !authenticated;
  if (!authenticated) {
    loginForm.reset();
  }
}

function setLoginError(message = "") {
  loginError.textContent = message;
  loginError.hidden = !message;
}

async function loadPortfolio() {
  const portfolio = await apiRequest("/api/data");
  applyRemoteData(portfolio);
  showAuthenticatedApp(true);
  render();
}

async function initializeApp() {
  showAuthenticatedApp(false);
  authGate.setAttribute("aria-busy", "true");
  try {
    await apiRequest("/api/auth/me");
    await loadPortfolio();
  } catch (error) {
    if (error.status !== 401) setLoginError("The secure workspace is temporarily unavailable. Please try again.");
  } finally {
    authGate.removeAttribute("aria-busy");
  }
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  setLoginError();
  const username = loginForm.elements.username.value.trim();
  const password = loginForm.elements.password.value;
  if (!username || !password) { setLoginError("Enter both your username and password."); return; }
  loginForm.setAttribute("aria-busy", "true");
  loginForm.querySelector("button[type='submit']").disabled = true;
  try {
    await apiRequest("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
    loginForm.elements.password.value = "";
    await loadPortfolio();
  } catch (error) {
    setLoginError(error.status === 401 ? "The username or password is incorrect." : (error.message || "Sign in could not be completed."));
    loginForm.elements.password.select();
  } finally {
    loginForm.setAttribute("aria-busy", "false");
    loginForm.querySelector("button[type='submit']").disabled = false;
  }
});

document.getElementById("logoutButton").addEventListener("click", async () => {
  try { await apiRequest("/api/auth/logout", { method: "POST", body: "{}" }); } catch { /* The local session is cleared below. */ }
  state.loans = []; state.customLoans = []; state.payments = {}; importedRecords = {};
  state.selectedLoanId = null; state.view = "overview";
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  initialLoanHash = null;
  showAuthenticatedApp(false);
});

initializeApp();

window.addEventListener("popstate", () => {
  if (state.view !== "detail") return;
  state.view = state.detailReturnView || "loans";
  state.selectedLoanId = null;
  render();
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
}
