/**
 * Seed Phase 6: Canteen POS, Medical Records, PTM Schedule,
 *               Online Quizzes, Alumni, Scholarship Workflow
 *
 * Usage: node src/db/seed_phase6.js
 *
 * Safe to re-run — uses ON CONFLICT DO NOTHING throughout.
 */

const pool = require('./index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a DATE string N days in the past */
const pastDate = (days) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Returns a DATE string N days in the future */
const futureDate = (days) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Returns a random integer between min and max (inclusive) */
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Pick a random element from an array */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

async function seed() {
  console.log('🌱 Seeding Phase 6 data...\n');

  // -------------------------------------------------------------------------
  // 0. Fetch existing IDs we depend on
  // -------------------------------------------------------------------------
  const [studRes, teachRes, classRes, subjRes, feeRes] = await Promise.all([
    pool.query('SELECT id FROM students ORDER BY id LIMIT 20'),
    pool.query('SELECT id FROM teachers ORDER BY id LIMIT 10'),
    pool.query('SELECT id FROM classes  ORDER BY id LIMIT 10'),
    pool.query('SELECT id FROM subjects ORDER BY id LIMIT 8'),
    pool.query('SELECT id FROM fee_heads ORDER BY id LIMIT 5'),
  ]);

  const studentIds = studRes.rows.map((r) => r.id);
  const teacherIds = teachRes.rows.map((r) => r.id);
  const classIds   = classRes.rows.map((r) => r.id);
  const subjectIds = subjRes.rows.map((r) => r.id);
  const feeHeadIds = feeRes.rows.map((r) => r.id);

  if (studentIds.length === 0) console.warn('⚠️  No students found — medical, PTM bookings, quiz attempts, alumni, scholarships will be skipped.');
  if (teacherIds.length === 0) console.warn('⚠️  No teachers found — PTM slots and quizzes will be skipped.');
  if (classIds.length   === 0) console.warn('⚠️  No classes found  — quizzes will be skipped.');
  if (subjectIds.length === 0) console.warn('⚠️  No subjects found — quizzes will be skipped.');
  if (feeHeadIds.length === 0) console.warn('⚠️  No fee_heads found — scholarships will skip fee_head_id.');

  // =========================================================================
  // SECTION 1: CANTEEN ITEMS + SALES
  // =========================================================================

  // ---- 1a. Canteen Items --------------------------------------------------
  process.stdout.write('🍽️  Canteen: inserting items...   ');

  const canteenItems = [
    { name: 'Samosa',       category: 'Food',      price: 20,  unit: 'piece'  },
    { name: 'Biryani',      category: 'Food',      price: 80,  unit: 'plate'  },
    { name: 'Cold Drink',   category: 'Beverages', price: 50,  unit: 'bottle' },
    { name: 'Juice',        category: 'Beverages', price: 40,  unit: 'glass'  },
    { name: 'Sandwich',     category: 'Food',      price: 60,  unit: 'piece'  },
    { name: 'Chips',        category: 'Snacks',    price: 30,  unit: 'pack'   },
    { name: 'Water Bottle', category: 'Beverages', price: 25,  unit: 'bottle' },
    { name: 'Naan Qorma',   category: 'Food',      price: 100, unit: 'plate'  },
    { name: 'Tea',          category: 'Beverages', price: 20,  unit: 'cup'    },
    { name: 'Biscuits',     category: 'Snacks',    price: 15,  unit: 'pack'   },
  ];

  const insertedItems = [];
  for (const item of canteenItems) {
    // Insert and return id + price so we can use them for sales
    const res = await pool.query(
      `INSERT INTO canteen_items (name, category, price, unit)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id, name, price`,
      [item.name, item.category, item.price, item.unit]
    );
    if (res.rows.length > 0) {
      insertedItems.push(res.rows[0]);
    }
  }

  // If items already existed, fetch them
  let itemsForSales = insertedItems;
  if (itemsForSales.length < canteenItems.length) {
    const existing = await pool.query(
      `SELECT id, name, price FROM canteen_items WHERE name = ANY($1::text[])`,
      [canteenItems.map((i) => i.name)]
    );
    itemsForSales = existing.rows;
  }

  console.log(`✅ ${canteenItems.length} items`);

  // ---- 1b. Canteen Sales (30 sales, each in its own transaction) ----------
  process.stdout.write('🍽️  Canteen: inserting sales...   ');

  // Look up (or create) income_categories 'Canteen'
  let canteenCatId = null;
  const catRes = await pool.query(
    `SELECT id FROM income_categories WHERE LOWER(name) = 'canteen' LIMIT 1`
  );
  if (catRes.rows.length > 0) {
    canteenCatId = catRes.rows[0].id;
  } else {
    // Try to insert it; if the table doesn't allow it just skip income entries
    try {
      const newCat = await pool.query(
        `INSERT INTO income_categories (name) VALUES ('Canteen') ON CONFLICT DO NOTHING RETURNING id`
      );
      if (newCat.rows.length > 0) canteenCatId = newCat.rows[0].id;
    } catch (_) {
      // income_categories may have required columns — skip income entries silently
    }
  }

  let salesInserted = 0;
  if (itemsForSales.length > 0) {
    for (let i = 0; i < 30; i++) {
      const item      = pick(itemsForSales);
      const quantity  = randInt(1, 5);
      const unitPrice = parseFloat(item.price);
      const total     = quantity * unitPrice;
      const saleDate  = pastDate(randInt(0, 29)); // spread across last 30 days

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Insert income entry first (if we have a category)
        let incomeEntryId = null;
        if (canteenCatId !== null) {
          try {
            const incRes = await client.query(
              `INSERT INTO income_entries (category_id, amount, description, entry_date, academic_year)
               VALUES ($1, $2, $3, $4, '2024-25')
               RETURNING id`,
              [canteenCatId, total, `Canteen sale: ${item.name} x${quantity}`, saleDate]
            );
            incomeEntryId = incRes.rows[0].id;
          } catch (_) {
            // income_entries schema mismatch — continue without linking
          }
        }

        // Insert canteen sale
        await client.query(
          `INSERT INTO canteen_sales
             (sale_date, item_id, item_name, quantity, unit_price, total_amount, income_entry_id, academic_year)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-25')`,
          [saleDate, item.id, item.name, quantity, unitPrice, total, incomeEntryId]
        );

        await client.query('COMMIT');
        salesInserted++;
      } catch (err) {
        await client.query('ROLLBACK');
        // log but continue so remaining sales still seed
        console.warn(`\n  ⚠️  Sale ${i + 1} rolled back: ${err.message}`);
      } finally {
        client.release();
      }
    }
  }

  console.log(`✅ ${salesInserted} sales`);

  // =========================================================================
  // SECTION 2: MEDICAL RECORDS
  // =========================================================================

  if (studentIds.length === 0) {
    console.log('🏥  Medical: skipped (no students)');
  } else {
    const medStudents  = studentIds.slice(0, 10);
    const vaccines     = ['Polio', 'Hepatitis B', 'BCG', 'MMR', 'COVID-19', 'Typhoid'];
    const givers       = ['School Health Team', 'DHQ Hospital'];
    const complaints   = [
      'Fever and cough',
      'Stomach ache',
      'Headache',
      'Minor cut on hand',
      'Dizziness',
      'Allergic reaction',
    ];
    const actions      = [
      'Paracetamol given, sent home',
      'First aid applied',
      'Referred to parents',
      'Rest recommended',
    ];

    // ---- 2a. Vaccinations -------------------------------------------------
    process.stdout.write('🏥  Medical: vaccinations...       ');
    let vaccinationCount = 0;
    for (const sid of medStudents) {
      const numVax = randInt(1, 2);
      const shuffled = [...vaccines].sort(() => Math.random() - 0.5);
      for (let v = 0; v < numVax; v++) {
        await pool.query(
          `INSERT INTO student_vaccinations
             (student_id, vaccine_name, dose_number, date_given, given_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [
            sid,
            shuffled[v],
            1,
            pastDate(randInt(30, 730)), // within past 2 years
            pick(givers),
          ]
        );
        vaccinationCount++;
      }
    }
    console.log(`✅ ${vaccinationCount} records`);

    // ---- 2b. Medical Visits -----------------------------------------------
    process.stdout.write('🏥  Medical: visits...             ');
    let visitCount = 0;
    for (const sid of medStudents) {
      const numVisits = randInt(1, 2);
      for (let v = 0; v < numVisits; v++) {
        await pool.query(
          `INSERT INTO student_medical_visits
             (student_id, visit_date, complaint, action_taken, recorded_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [
            sid,
            pastDate(randInt(1, 180)), // within past 6 months
            pick(complaints),
            pick(actions),
            'School Nurse',
          ]
        );
        visitCount++;
      }
    }
    console.log(`✅ ${visitCount} records`);
  }

  // =========================================================================
  // SECTION 3: PTM MEETING SLOTS + BOOKINGS
  // =========================================================================

  if (teacherIds.length === 0) {
    console.log('📅  PTM: skipped (no teachers)');
  } else {
    const ptmTeachers  = teacherIds.slice(0, 5);
    const date1        = futureDate(7);
    const date2        = futureDate(14);
    const locations    = ['Room 101', 'Staff Room', 'Principal Office', 'Room 202', 'Library'];
    const slotTimes    = [
      { start: '09:00', end: '09:15' },
      { start: '09:15', end: '09:30' },
      { start: '09:30', end: '09:45' },
    ];

    // ---- 3a. Meeting Slots ------------------------------------------------
    process.stdout.write('📅  PTM: slots...                  ');
    const insertedSlotIds = []; // [ { slotId, teacherIdx, dateLabel } ]

    for (let ti = 0; ti < ptmTeachers.length; ti++) {
      const teacherId = ptmTeachers[ti];
      for (const date of [date1, date2]) {
        for (const slot of slotTimes) {
          const res = await pool.query(
            `INSERT INTO meeting_slots
               (teacher_id, slot_date, start_time, end_time, duration_min, location, academic_year)
             VALUES ($1, $2, $3, $4, 15, $5, '2024-25')
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [teacherId, date, slot.start, slot.end, locations[ti % locations.length]]
          );
          if (res.rows.length > 0) {
            insertedSlotIds.push({ slotId: res.rows[0].id, teacherIdx: ti, date });
          }
        }
      }
    }
    console.log(`✅ ${ptmTeachers.length * 2 * slotTimes.length} slots`);

    // ---- 3b. PTM Bookings -------------------------------------------------
    process.stdout.write('📅  PTM: bookings...               ');

    if (studentIds.length === 0) {
      console.log('skipped (no students)');
    } else {
      const parentNames  = [
        'Mr. Ahmed Ali',
        'Mr. Hassan Khan',
        'Mr. Imran Hussain',
        'Mr. Tariq Mehmood',
        'Mr. Bilal Akhtar',
        'Mr. Usman Farooq',
      ];
      const parentPhones = [
        '03001234567',
        '03211234567',
        '03331234567',
        '03451234567',
        '03111234567',
        '03021234567',
      ];

      // One booking per teacher for date1 (first slot of that teacher on date1)
      const date1Slots = insertedSlotIds.filter((s) => s.date === date1);
      // Group by teacherIdx, take first slot per teacher
      const bookingSlots = [];
      const seenTeachers = new Set();
      for (const s of date1Slots) {
        if (!seenTeachers.has(s.teacherIdx)) {
          seenTeachers.add(s.teacherIdx);
          bookingSlots.push(s);
        }
        if (bookingSlots.length === 6) break;
      }

      let bookingCount = 0;
      for (let i = 0; i < Math.min(bookingSlots.length, 6); i++) {
        const { slotId } = bookingSlots[i];
        const sid        = studentIds[i] ?? studentIds[0];

        try {
          await pool.query(
            `INSERT INTO meeting_bookings
               (slot_id, student_id, parent_name, parent_phone, status)
             VALUES ($1, $2, $3, $4, 'confirmed')
             ON CONFLICT DO NOTHING`,
            [slotId, sid, parentNames[i], parentPhones[i]]
          );

          await pool.query(
            `UPDATE meeting_slots SET is_booked = TRUE WHERE id = $1`,
            [slotId]
          );
          bookingCount++;
        } catch (err) {
          console.warn(`\n  ⚠️  PTM booking ${i + 1} failed: ${err.message}`);
        }
      }
      console.log(`✅ ${bookingCount} bookings`);
    }
  }

  // =========================================================================
  // SECTION 4: QUIZZES + QUESTIONS + ATTEMPTS
  // =========================================================================

  if (teacherIds.length === 0 || classIds.length === 0 || subjectIds.length === 0) {
    console.log('📝  Quizzes: skipped (missing teachers/classes/subjects)');
  } else {
    process.stdout.write('📝  Quizzes: creating...           ');

    const cId  = (n) => classIds[n]   ?? classIds[0];
    const sId  = (n) => subjectIds[n] ?? subjectIds[0];
    const tId  = (n) => teacherIds[n] ?? teacherIds[0];

    // Helper: insert a quiz and return its id
    const insertQuiz = async (quiz) => {
      const res = await pool.query(
        `INSERT INTO quizzes
           (title, class_id, subject_id, teacher_id, instructions,
            duration_min, total_marks, pass_marks, status, open_from, open_until, academic_year)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'2024-25')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          quiz.title,
          quiz.class_id,
          quiz.subject_id,
          quiz.teacher_id,
          quiz.instructions,
          quiz.duration_min,
          quiz.total_marks,
          quiz.pass_marks,
          quiz.status,
          quiz.open_from ?? null,
          quiz.open_until ?? null,
        ]
      );
      if (res.rows.length > 0) return res.rows[0].id;
      // Already exists — fetch id by title
      const existing = await pool.query(
        `SELECT id FROM quizzes WHERE title = $1 LIMIT 1`,
        [quiz.title]
      );
      return existing.rows[0]?.id ?? null;
    };

    // Helper: insert a question and return its id
    const insertQuestion = async (q) => {
      const res = await pool.query(
        `INSERT INTO quiz_questions
           (quiz_id, question_text, question_type, marks, options, correct_option, order_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [q.quiz_id, q.text, q.type, q.marks, q.options ? JSON.stringify(q.options) : null, q.correct ?? null, q.order_no]
      );
      if (res.rows.length > 0) return res.rows[0].id;
      const existing = await pool.query(
        `SELECT id FROM quiz_questions WHERE quiz_id = $1 AND order_no = $2 LIMIT 1`,
        [q.quiz_id, q.order_no]
      );
      return existing.rows[0]?.id ?? null;
    };

    let totalQuizzes   = 0;
    let totalQuestions = 0;

    // ------------------------------------------------------------------
    // Quiz 1: Mathematics Mid-Term Quiz
    // ------------------------------------------------------------------
    const q1Id = await insertQuiz({
      title        : 'Mathematics Mid-Term Quiz',
      class_id     : cId(0),
      subject_id   : sId(0),
      teacher_id   : tId(0),
      instructions : 'Answer all questions. Show working where required.',
      duration_min : 30,
      total_marks  : 20,
      pass_marks   : 10,
      status       : 'published',
      open_from    : new Date(Date.now() - 2 * 86400000).toISOString(),
      open_until   : new Date(Date.now() + 5 * 86400000).toISOString(),
    });
    if (q1Id) {
      totalQuizzes++;
      const q1Questions = [
        { quiz_id: q1Id, text: 'What is 15 × 8?',                          type: 'mcq',          marks: 2, options: { A: '110', B: '120', C: '130', D: '140' }, correct: 'B', order_no: 1 },
        { quiz_id: q1Id, text: 'Which is a prime number?',                  type: 'mcq',          marks: 2, options: { A: '9',   B: '15',  C: '17',  D: '21'  }, correct: 'C', order_no: 2 },
        { quiz_id: q1Id, text: 'What is the square root of 144?',           type: 'mcq',          marks: 2, options: { A: '10',  B: '11',  C: '12',  D: '13'  }, correct: 'C', order_no: 3 },
        { quiz_id: q1Id, text: 'Solve: 3x + 6 = 21, x = ?',               type: 'mcq',          marks: 2, options: { A: '3',   B: '4',   C: '5',   D: '6'   }, correct: 'C', order_no: 4 },
        { quiz_id: q1Id, text: 'Explain the Pythagoras theorem in your own words.', type: 'short_answer', marks: 4, options: null, correct: null, order_no: 5 },
        { quiz_id: q1Id, text: 'A train travels 240km in 3 hours. What is its speed?', type: 'short_answer', marks: 4, options: null, correct: null, order_no: 6 },
        { quiz_id: q1Id, text: 'What is 25% of 200?',                       type: 'mcq',          marks: 2, options: { A: '25',  B: '50',  C: '75',  D: '100' }, correct: 'B', order_no: 7 },
        { quiz_id: q1Id, text: 'What is the value of π (pi) approximately?', type: 'mcq',         marks: 2, options: { A: '3.14', B: '3.41', C: '2.14', D: '4.13' }, correct: 'A', order_no: 8 },
      ];
      for (const q of q1Questions) {
        const qId = await insertQuestion(q);
        if (qId) totalQuestions++;
      }
    }

    // ------------------------------------------------------------------
    // Quiz 2: Science Chapter 3 Test
    // ------------------------------------------------------------------
    const q2Id = await insertQuiz({
      title        : 'Science Chapter 3 Test',
      class_id     : cId(1),
      subject_id   : sId(1),
      teacher_id   : tId(1),
      instructions : 'Read each question carefully before answering.',
      duration_min : 20,
      total_marks  : 15,
      pass_marks   : 8,
      status       : 'published',
      open_from    : new Date(Date.now() - 1 * 86400000).toISOString(),
      open_until   : new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    if (q2Id) {
      totalQuizzes++;
      const q2Questions = [
        { quiz_id: q2Id, text: 'What is the chemical formula of water?',          type: 'mcq',          marks: 2, options: { A: 'H2O2', B: 'H2O',       C: 'HO2',       D: 'H3O'      }, correct: 'B', order_no: 1 },
        { quiz_id: q2Id, text: 'Which planet is closest to the Sun?',             type: 'mcq',          marks: 2, options: { A: 'Venus', B: 'Earth',     C: 'Mercury',   D: 'Mars'     }, correct: 'C', order_no: 2 },
        { quiz_id: q2Id, text: 'What is the speed of light?',                     type: 'mcq',          marks: 2, options: { A: '3×10^6 m/s', B: '3×10^8 m/s', C: '3×10^10 m/s', D: '3×10^4 m/s' }, correct: 'B', order_no: 3 },
        { quiz_id: q2Id, text: 'What is photosynthesis? Write the equation.',     type: 'short_answer', marks: 5, options: null, correct: null, order_no: 4 },
        { quiz_id: q2Id, text: 'Human body has how many bones?',                  type: 'mcq',          marks: 2, options: { A: '196', B: '206',       C: '216',       D: '226'      }, correct: 'B', order_no: 5 },
        { quiz_id: q2Id, text: 'Name three states of matter and give one example of each.', type: 'short_answer', marks: 2, options: null, correct: null, order_no: 6 },
      ];
      for (const q of q2Questions) {
        const qId = await insertQuestion(q);
        if (qId) totalQuestions++;
      }
    }

    // ------------------------------------------------------------------
    // Quiz 3: English Grammar Quiz (closed — will have attempts)
    // ------------------------------------------------------------------
    const q3Id = await insertQuiz({
      title        : 'English Grammar Quiz',
      class_id     : cId(0),
      subject_id   : sId(2),
      teacher_id   : tId(0),
      instructions : 'Choose the best answer for MCQs. Write complete sentences for short answers.',
      duration_min : 25,
      total_marks  : 20,
      pass_marks   : 10,
      status       : 'closed',
      open_from    : null,
      open_until   : null,
    });

    // We need question IDs for attempts, so collect them
    const q3QuestionDefs = [
      { text: "Choose the correct spelling:",                                           type: 'mcq',          marks: 2, options: { A: 'Acommodate', B: 'Accommodate', C: 'Accomodate', D: 'Acomodate' }, correct: 'B', order_no: 1 },
      { text: "Which sentence is grammatically correct?",                               type: 'mcq',          marks: 2, options: { A: "She don't know", B: "She doesn't knows", C: "She doesn't know", D: "She not know" }, correct: 'C', order_no: 2 },
      { text: "Synonym of 'Happy' is:",                                                 type: 'mcq',          marks: 2, options: { A: 'Sad', B: 'Angry', C: 'Joyful', D: 'Tired' }, correct: 'C', order_no: 3 },
      { text: "The plural of 'child' is:",                                              type: 'mcq',          marks: 2, options: { A: 'Childs', B: 'Childes', C: 'Children', D: 'Childrens' }, correct: 'C', order_no: 4 },
      { text: "Past tense of 'run' is:",                                               type: 'mcq',          marks: 2, options: { A: 'Runned', B: 'Ran', C: 'Ranned', D: 'Running' }, correct: 'B', order_no: 5 },
      { text: "Write 5 sentences using present perfect tense.",                        type: 'short_answer', marks: 5, options: null, correct: null, order_no: 6 },
      { text: "Explain the difference between 'their', 'there' and 'they're' with examples.", type: 'short_answer', marks: 5, options: null, correct: null, order_no: 7 },
    ];

    const q3QuestionIds = []; // { id, type, marks, correct }
    if (q3Id) {
      totalQuizzes++;
      for (const q of q3QuestionDefs) {
        const qId = await insertQuestion({ quiz_id: q3Id, ...q });
        if (qId) {
          totalQuestions++;
          q3QuestionIds.push({ id: qId, type: q.type, marks: q.marks, correct: q.correct });
        }
      }
    }

    console.log(`✅ ${totalQuizzes} quizzes, ${totalQuestions} questions`);

    // ---- 4b. Quiz Attempts (Quiz 3 — closed) ------------------------------
    process.stdout.write('📝  Quizzes: attempts...           ');

    let attemptCount = 0;
    if (q3Id && q3QuestionIds.length > 0 && studentIds.length > 0) {
      const attemptStudents = studentIds.slice(0, 5);

      // MCQ option pool for random wrong/right answers
      const allOptions    = ['A', 'B', 'C', 'D'];
      const submittedAt   = new Date(Date.now() - 3 * 86400000).toISOString();

      for (const sid of attemptStudents) {
        // Insert attempt
        let attemptId = null;
        try {
          const aRes = await pool.query(
            `INSERT INTO quiz_attempts
               (quiz_id, student_id, started_at, submitted_at, total_marks, status, is_graded)
             VALUES ($1, $2, $3, $4, $5, 'graded', TRUE)
             ON CONFLICT (quiz_id, student_id) DO NOTHING
             RETURNING id`,
            [q3Id, sid, submittedAt, submittedAt, 20]
          );
          if (aRes.rows.length > 0) {
            attemptId = aRes.rows[0].id;
          } else {
            // Already exists
            const existing = await pool.query(
              `SELECT id FROM quiz_attempts WHERE quiz_id = $1 AND student_id = $2`,
              [q3Id, sid]
            );
            attemptId = existing.rows[0]?.id ?? null;
          }
        } catch (err) {
          console.warn(`\n  ⚠️  Attempt for student ${sid}: ${err.message}`);
          continue;
        }

        if (!attemptId) continue;

        // Insert answers for each question
        let scoredMarks = 0;
        for (const qDef of q3QuestionIds) {
          let answerText  = null;
          let isCorrect   = null;
          let marksAwarded = 0;
          let feedback    = null;

          if (qDef.type === 'mcq') {
            // 60% chance of correct answer
            const correct = Math.random() < 0.6;
            answerText    = correct ? qDef.correct : pick(allOptions.filter((o) => o !== qDef.correct));
            isCorrect     = answerText === qDef.correct;
            marksAwarded  = isCorrect ? qDef.marks : 0;
          } else {
            // short_answer
            marksAwarded  = pick([3, 4]);
            feedback      = pick(['Good attempt', 'Needs improvement', 'Well explained', 'Partially correct']);
          }

          scoredMarks += marksAwarded;

          try {
            await pool.query(
              `INSERT INTO quiz_answers
                 (attempt_id, question_id, answer_text, is_correct, marks_awarded, teacher_feedback)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (attempt_id, question_id) DO NOTHING`,
              [attemptId, qDef.id, answerText, isCorrect, marksAwarded, feedback]
            );
          } catch (err) {
            // skip duplicate answers silently
          }
        }

        // Update scored_marks on the attempt
        await pool.query(
          `UPDATE quiz_attempts SET scored_marks = $1 WHERE id = $2`,
          [scoredMarks, attemptId]
        );

        attemptCount++;
      }
    }

    console.log(`✅ ${attemptCount} attempts graded`);
  }

  // =========================================================================
  // SECTION 5: ALUMNI
  // =========================================================================

  if (studentIds.length < 5) {
    console.log('🎓  Alumni: skipped (need at least 5 students)');
  } else {
    process.stdout.write('🎓  Alumni: graduating students... ');

    // Use last 5 students
    const alumniStudents = studentIds.slice(-5);

    const alumniData = [
      {
        student_id      : alumniStudents[0],
        graduation_year : 2024,
        batch_label     : 'Class of 2024',
        final_class     : 'Class 10',
        university      : 'University of Punjab',
        program         : 'BSc Computer Science',
        university_year : 2024,
        current_city    : 'Lahore',
        contact_email   : 'ahmed.ali2024@gmail.com',
        contact_phone   : '03001112233',
      },
      {
        student_id      : alumniStudents[1],
        graduation_year : 2024,
        batch_label     : 'Class of 2024',
        final_class     : 'Class 10',
        university      : 'COMSATS University',
        program         : 'BBA',
        university_year : 2024,
        current_city    : 'Islamabad',
        contact_email   : 'hassan.khan2024@yahoo.com',
        contact_phone   : '03211112233',
      },
      {
        student_id      : alumniStudents[2],
        graduation_year : 2023,
        batch_label     : 'Class of 2023',
        final_class     : 'Class 10',
        university      : 'NUST',
        program         : 'BE Electrical Engineering',
        university_year : 2023,
        current_city    : 'Rawalpindi',
        contact_email   : 'imran.hussain23@outlook.com',
        contact_phone   : '03331112233',
      },
      {
        student_id      : alumniStudents[3],
        graduation_year : 2023,
        batch_label     : 'Class of 2023',
        final_class     : 'Class 10',
        university      : 'UET Lahore',
        program         : 'BE Civil Engineering',
        university_year : 2023,
        current_city    : 'Lahore',
        contact_email   : 'tariq.mehmood23@gmail.com',
        contact_phone   : '03451112233',
      },
      {
        student_id      : alumniStudents[4],
        graduation_year : 2022,
        batch_label     : 'Class of 2022',
        final_class     : 'Class 10',
        university      : 'IBA Karachi',
        program         : 'BBA Finance',
        university_year : 2022,
        current_city    : 'Karachi',
        contact_email   : 'bilal.akhtar22@gmail.com',
        contact_phone   : '03111112233',
      },
    ];

    let alumniCount = 0;
    for (const a of alumniData) {
      // Mark student as graduated
      await pool.query(
        `UPDATE students SET status = 'graduated', graduation_year = $1 WHERE id = $2`,
        [a.graduation_year, a.student_id]
      );

      // Insert alumni record
      const res = await pool.query(
        `INSERT INTO alumni
           (student_id, graduation_year, batch_label, final_class,
            university, program, university_year, current_city, current_country,
            contact_email, contact_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Pakistan',$9,$10)
         ON CONFLICT (student_id) DO NOTHING`,
        [
          a.student_id,
          a.graduation_year,
          a.batch_label,
          a.final_class,
          a.university,
          a.program,
          a.university_year,
          a.current_city,
          a.contact_email,
          a.contact_phone,
        ]
      );
      if (res.rowCount > 0 || res.rows) alumniCount++;
    }

    console.log(`✅ ${alumniData.length} alumni records`);
  }

  // =========================================================================
  // SECTION 6: SCHOLARSHIPS
  // =========================================================================

  if (studentIds.length < 6) {
    console.log('🏆  Scholarships: skipped (need at least 6 students)');
  } else {
    process.stdout.write('🏆  Scholarships: applications...  ');

    const scholarshipStudents = studentIds.slice(0, 6);
    const feeHeadId           = feeHeadIds[0] ?? null;

    const applications = [
      // 2 pending
      {
        student_id    : scholarshipStudents[0],
        fee_head_id   : feeHeadId,
        discount_type : 'percent',
        discount_value: 50,
        reason        : 'Financial hardship — father lost job',
        status        : 'pending',
        admin_note    : null,
        reviewed_by   : null,
        reviewed_at   : null,
      },
      {
        student_id    : scholarshipStudents[1],
        fee_head_id   : feeHeadId,
        discount_type : 'fixed',
        discount_value: 500,
        reason        : 'Orphan student',
        status        : 'pending',
        admin_note    : null,
        reviewed_by   : null,
        reviewed_at   : null,
      },
      // 2 approved
      {
        student_id    : scholarshipStudents[2],
        fee_head_id   : feeHeadId,
        discount_type : 'percent',
        discount_value: 25,
        reason        : 'Academic excellence — top of class',
        status        : 'approved',
        admin_note    : 'Approved by principal',
        reviewed_by   : 'Principal Saeed Ahmed',
        reviewed_at   : new Date(Date.now() - 7 * 86400000).toISOString(),
      },
      {
        student_id    : scholarshipStudents[3],
        fee_head_id   : feeHeadId,
        discount_type : 'fixed',
        discount_value: 1000,
        reason        : 'Sports achievement — district cricket champion',
        status        : 'approved',
        admin_note    : 'Approved — sports excellence award',
        reviewed_by   : 'Principal Saeed Ahmed',
        reviewed_at   : new Date(Date.now() - 5 * 86400000).toISOString(),
      },
      // 1 under_review
      {
        student_id    : scholarshipStudents[4],
        fee_head_id   : feeHeadId,
        discount_type : 'percent',
        discount_value: 30,
        reason        : 'Single parent household',
        status        : 'under_review',
        admin_note    : null,
        reviewed_by   : null,
        reviewed_at   : null,
      },
      // 1 rejected
      {
        student_id    : scholarshipStudents[5],
        fee_head_id   : feeHeadId,
        discount_type : 'percent',
        discount_value: 75,
        reason        : 'Insufficient documentation provided',
        status        : 'rejected',
        admin_note    : 'Documents not verified',
        reviewed_by   : 'Admin Office',
        reviewed_at   : new Date(Date.now() - 3 * 86400000).toISOString(),
      },
    ];

    let appCount     = 0;
    let approvedCount = 0;

    for (const app of applications) {
      let concessionId = null;

      // For approved applications: insert student_concession first
      if (app.status === 'approved') {
        try {
          const concRes = await pool.query(
            `INSERT INTO student_concessions
               (student_id, fee_head_id, discount_type, discount_value, reason, is_active)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [
              app.student_id,
              app.fee_head_id,
              app.discount_type,
              app.discount_value,
              app.reason,
            ]
          );
          if (concRes.rows.length > 0) {
            concessionId = concRes.rows[0].id;
          } else {
            // May already exist — look it up
            const existing = await pool.query(
              `SELECT id FROM student_concessions
               WHERE student_id = $1 AND discount_type = $2 AND discount_value = $3
               LIMIT 1`,
              [app.student_id, app.discount_type, app.discount_value]
            );
            concessionId = existing.rows[0]?.id ?? null;
          }
          approvedCount++;
        } catch (err) {
          console.warn(`\n  ⚠️  Concession insert failed for student ${app.student_id}: ${err.message}`);
        }
      }

      // Insert scholarship application
      try {
        await pool.query(
          `INSERT INTO scholarship_applications
             (student_id, fee_head_id, discount_type, discount_value, reason,
              status, admin_note, reviewed_by, reviewed_at, concession_id, academic_year)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'2024-25')
           ON CONFLICT DO NOTHING`,
          [
            app.student_id,
            app.fee_head_id,
            app.discount_type,
            app.discount_value,
            app.reason,
            app.status,
            app.admin_note,
            app.reviewed_by,
            app.reviewed_at,
            concessionId,
          ]
        );
        appCount++;
      } catch (err) {
        console.warn(`\n  ⚠️  Scholarship insert failed for student ${app.student_id}: ${err.message}`);
      }
    }

    console.log(`✅ ${appCount} applications (${approvedCount} approved)`);
  }

  // =========================================================================
  // Done
  // =========================================================================
  console.log('\n✅ Phase 6 seed complete!');

  await pool.end();
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
