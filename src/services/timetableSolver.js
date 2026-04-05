function solve({ classes, teachers, subjects, days, periodsPerDay }) {
  const timetable = {};
  days.forEach(d => { timetable[d] = {}; for (let p = 1; p <= periodsPerDay; p++) timetable[d][p] = {}; });

  const teacherPeriods = {};
  days.forEach(d => { teacherPeriods[d] = {}; });

  const slots = [], conflicts = [];

  const requirements = [];
  for (const subj of subjects) {
    const perWeek = subj.periods_per_week || 1;
    for (let i = 0; i < perWeek; i++) requirements.push({ ...subj });
  }
  shuffleArray(requirements);

  for (const req of requirements) {
    const { class_id, subject_id, teacher_id } = req;
    const teacher   = teachers.find(t => t.id === teacher_id);
    const maxPerDay = teacher?.max_periods_per_day || 5;
    let placed = false;

    outer:
    for (const day of shuffleArray([...days])) {
      for (let period = 1; period <= periodsPerDay; period++) {
        if (timetable[day][period][class_id]) continue;
        const teacherBusy = Object.values(timetable[day][period]).some(s => s.teacher_id === teacher_id);
        if (teacherBusy) continue;
        const load = teacherPeriods[day][teacher_id] || 0;
        if (load >= maxPerDay) continue;

        timetable[day][period][class_id] = { subject_id, teacher_id };
        teacherPeriods[day][teacher_id]  = load + 1;
        slots.push({ class_id, subject_id, teacher_id, day, period });
        placed = true;
        break outer;
      }
    }

    if (!placed) {
      const subjectName = req.name || `Subject ${subject_id}`;
      const className   = classes.find(c => c.id === class_id)?.name || class_id;
      conflicts.push(`Could not place "${subjectName}" for "${className}"`);
    }
  }

  return { slots, conflicts };
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { solve };
