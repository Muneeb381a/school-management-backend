-- ============================================================
--  SchoolMS — Full Database Schema
--  Drop order respects FK dependencies (children before parents)
-- ============================================================

DROP TABLE IF EXISTS fee_payments;
DROP TABLE IF EXISTS fee_invoice_items;
DROP TABLE IF EXISTS fee_invoices;
DROP TABLE IF EXISTS fee_structures;
DROP TABLE IF EXISTS fee_heads;
DROP TABLE IF EXISTS attendance;
DROP TABLE IF EXISTS timetable_entries;
DROP TABLE IF EXISTS periods;
DROP TABLE IF EXISTS teacher_classes;
DROP TABLE IF EXISTS students;
DROP TABLE IF EXISTS classes;
DROP TABLE IF EXISTS teachers;

-- ============================================================
--  TEACHERS
-- ============================================================
CREATE TABLE teachers (
  id                SERIAL        PRIMARY KEY,
  full_name         VARCHAR(150)  NOT NULL,
  email             VARCHAR(150)  UNIQUE,
  phone             VARCHAR(20),
  gender            VARCHAR(10),
  date_of_birth     DATE,
  qualification     VARCHAR(60),
  subject           VARCHAR(100),          -- primary subject / specialization
  join_date         DATE,
  status            VARCHAR(20)   DEFAULT 'active'  CHECK (status IN ('active','inactive','on_leave')),
  address           TEXT,
  assigned_grades   TEXT[],                -- e.g. ARRAY['Class 5','Class 6']
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
--  CLASSES
--  teacher_id → the designated "class teacher" (FK to teachers)
-- ============================================================
CREATE TABLE classes (
  id              SERIAL        PRIMARY KEY,
  name            VARCHAR(100)  NOT NULL,
  grade           VARCHAR(20)   NOT NULL,
  section         VARCHAR(10)   NOT NULL,
  academic_year   VARCHAR(10)   NOT NULL   DEFAULT '2024-25',
  room_number     VARCHAR(20),
  capacity        INT           DEFAULT 40,
  teacher_id      INT           REFERENCES teachers(id) ON DELETE SET NULL,
  description     TEXT,
  status          VARCHAR(20)   DEFAULT 'active'  CHECK (status IN ('active','inactive')),
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(grade, section, academic_year)
);

-- ============================================================
--  TEACHER ↔ CLASS ASSIGNMENTS  (many-to-many)
--  A teacher can teach in many classes (for different subjects).
--  A class can have many subject teachers.
-- ============================================================
CREATE TABLE teacher_classes (
  id          SERIAL        PRIMARY KEY,
  teacher_id  INT           NOT NULL  REFERENCES teachers(id) ON DELETE CASCADE,
  class_id    INT           NOT NULL  REFERENCES classes(id)  ON DELETE CASCADE,
  subject     VARCHAR(100),           -- subject taught in this class
  role        VARCHAR(30)   DEFAULT 'subject_teacher'
                            CHECK (role IN ('class_teacher','subject_teacher')),
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(teacher_id, class_id, role)
);

-- ============================================================
--  STUDENTS
-- ============================================================
CREATE TABLE students (
  id                  SERIAL        PRIMARY KEY,
  class_id            INT           REFERENCES classes(id) ON DELETE SET NULL,

  -- Identity
  full_name           VARCHAR(150)  NOT NULL,
  full_name_urdu      VARCHAR(150),
  date_of_birth       DATE,
  place_of_birth      VARCHAR(100),
  gender              VARCHAR(10),
  religion            VARCHAR(50),
  nationality         VARCHAR(50)   DEFAULT 'Pakistani',
  b_form_no           VARCHAR(20),
  blood_group         VARCHAR(5),

  -- Contact
  email               VARCHAR(150)  UNIQUE,
  phone               VARCHAR(20),
  emergency_contact   VARCHAR(20),
  address             TEXT,
  city                VARCHAR(100),
  province            VARCHAR(60),
  postal_code         VARCHAR(10),

  -- Academic
  grade               VARCHAR(20),
  section             VARCHAR(10),
  roll_number         VARCHAR(20),
  admission_date      DATE          DEFAULT CURRENT_DATE,
  previous_school     VARCHAR(200),
  previous_class      VARCHAR(20),
  previous_marks      VARCHAR(20),
  leaving_reason      TEXT,

  -- Father
  father_name         VARCHAR(150),
  father_cnic         VARCHAR(15),
  father_occupation   VARCHAR(100),
  father_education    VARCHAR(100),
  father_phone        VARCHAR(20),
  father_email        VARCHAR(150),

  -- Mother
  mother_name         VARCHAR(150),
  mother_cnic         VARCHAR(15),
  mother_occupation   VARCHAR(100),
  mother_phone        VARCHAR(20),

  -- Guardian
  guardian_name       VARCHAR(150),
  guardian_relation   VARCHAR(50),
  guardian_phone      VARCHAR(20),
  guardian_cnic       VARCHAR(15),

  -- Health
  medical_condition   TEXT,
  allergies           TEXT,
  disability          VARCHAR(200),

  -- Extras
  transport_required  BOOLEAN       DEFAULT FALSE,
  transport_route     VARCHAR(100),
  hostel_required     BOOLEAN       DEFAULT FALSE,
  siblings_in_school  TEXT,
  extra_curricular    TEXT,
  house_color         VARCHAR(30),

  status              VARCHAR(20)   DEFAULT 'active'
                      CHECK (status IN ('active','inactive','suspended','graduated')),
  created_at          TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
--  PERIODS  (reusable bell schedule definitions)
-- ============================================================
CREATE TABLE periods (
  id          SERIAL       PRIMARY KEY,
  period_no   INT          NOT NULL,
  name        VARCHAR(50)  NOT NULL,          -- e.g. "Period 1", "Lunch Break"
  start_time  TIME         NOT NULL,
  end_time    TIME         NOT NULL,
  is_break    BOOLEAN      DEFAULT FALSE,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ============================================================
--  TIMETABLE ENTRIES  (class × day × period → teacher + subject)
-- ============================================================
CREATE TABLE timetable_entries (
  id            SERIAL       PRIMARY KEY,
  class_id      INT          NOT NULL  REFERENCES classes(id)  ON DELETE CASCADE,
  period_id     INT          NOT NULL  REFERENCES periods(id)  ON DELETE CASCADE,
  day_of_week   INT          NOT NULL  CHECK (day_of_week BETWEEN 1 AND 6),
                                        -- 1=Monday … 6=Saturday
  teacher_id    INT                    REFERENCES teachers(id) ON DELETE SET NULL,
  subject       VARCHAR(100),
  room          VARCHAR(20),
  academic_year VARCHAR(10)  DEFAULT '2024-25',
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(class_id, period_id, day_of_week, academic_year)
);

-- ============================================================
--  USEFUL INDEXES
-- ============================================================
CREATE INDEX idx_students_class_id    ON students(class_id);
CREATE INDEX idx_students_status      ON students(status);
CREATE INDEX idx_students_full_name   ON students(full_name);
CREATE INDEX idx_classes_grade        ON classes(grade);
CREATE INDEX idx_classes_teacher_id   ON classes(teacher_id);
CREATE INDEX idx_teacher_classes_tid  ON teacher_classes(teacher_id);
CREATE INDEX idx_teacher_classes_cid  ON teacher_classes(class_id);
CREATE INDEX idx_teachers_status      ON teachers(status);
CREATE INDEX idx_timetable_class_id   ON timetable_entries(class_id);
CREATE INDEX idx_timetable_period_id  ON timetable_entries(period_id);
CREATE INDEX idx_timetable_teacher_id ON timetable_entries(teacher_id);

-- ============================================================
--  ATTENDANCE
--  Tracks daily (or period-wise) attendance for students + teachers.
--  Two partial unique indexes handle the nullable period_id correctly.
-- ============================================================
CREATE TABLE attendance (
  id           SERIAL        PRIMARY KEY,
  entity_type  VARCHAR(10)   NOT NULL  CHECK (entity_type IN ('student','teacher')),
  entity_id    INT           NOT NULL,
  class_id     INT                     REFERENCES classes(id)  ON DELETE SET NULL,
  period_id    INT                     REFERENCES periods(id)  ON DELETE SET NULL,
  date         DATE          NOT NULL  DEFAULT CURRENT_DATE,
  status       VARCHAR(10)   NOT NULL  DEFAULT 'present'
                             CHECK (status IN ('present','absent','late','excused')),
  remarks      TEXT,
  marked_by    INT                     REFERENCES teachers(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ   DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   DEFAULT NOW()
);

-- Unique: one record per student/teacher per day (daily attendance)
CREATE UNIQUE INDEX uq_attendance_daily
  ON attendance(entity_type, entity_id, date)
  WHERE period_id IS NULL;

-- Unique: one record per student per day per period (period-wise)
CREATE UNIQUE INDEX uq_attendance_period
  ON attendance(entity_type, entity_id, date, period_id)
  WHERE period_id IS NOT NULL;

CREATE INDEX idx_attendance_entity    ON attendance(entity_type, entity_id);
CREATE INDEX idx_attendance_date      ON attendance(date);
CREATE INDEX idx_attendance_class_id  ON attendance(class_id);
CREATE INDEX idx_attendance_period_id ON attendance(period_id);

-- ============================================================
--  FEE HEADS  (master catalogue of all fee types)
-- ============================================================
CREATE TABLE fee_heads (
  id          SERIAL        PRIMARY KEY,
  name        VARCHAR(100)  NOT NULL,
  category    VARCHAR(20)   NOT NULL  CHECK (category IN ('admission','monthly','one_time')),
  description TEXT,
  is_active   BOOLEAN       DEFAULT TRUE,
  sort_order  INT           DEFAULT 0,
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
--  FEE STRUCTURES  (amount per fee_head per class / academic year)
-- ============================================================
CREATE TABLE fee_structures (
  id            SERIAL        PRIMARY KEY,
  fee_head_id   INT           NOT NULL  REFERENCES fee_heads(id)  ON DELETE CASCADE,
  class_id      INT                     REFERENCES classes(id)    ON DELETE CASCADE,
  grade         VARCHAR(20),            -- optional grade override
  amount        NUMERIC(10,2) NOT NULL  DEFAULT 0,
  academic_year VARCHAR(10)   NOT NULL  DEFAULT '2024-25',
  is_active     BOOLEAN       DEFAULT TRUE,
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(fee_head_id, class_id, academic_year)
);

-- ============================================================
--  FEE INVOICES  (one invoice per student per billing period)
-- ============================================================
CREATE TABLE fee_invoices (
  id              SERIAL        PRIMARY KEY,
  invoice_no      VARCHAR(30)   UNIQUE,
  student_id      INT           NOT NULL  REFERENCES students(id) ON DELETE CASCADE,
  class_id        INT                     REFERENCES classes(id)  ON DELETE SET NULL,
  invoice_type    VARCHAR(20)   NOT NULL  CHECK (invoice_type IN ('admission','monthly','one_time')),
  billing_month   VARCHAR(7),             -- YYYY-MM; NULL for admission / one_time
  due_date        DATE,
  total_amount    NUMERIC(10,2) NOT NULL  DEFAULT 0,
  paid_amount     NUMERIC(10,2) NOT NULL  DEFAULT 0,
  discount_amount NUMERIC(10,2) NOT NULL  DEFAULT 0,
  fine_amount     NUMERIC(10,2) NOT NULL  DEFAULT 0,
  status          VARCHAR(20)   NOT NULL  DEFAULT 'unpaid'
                  CHECK (status IN ('paid','unpaid','partial','overdue','cancelled','waived')),
  academic_year   VARCHAR(10)             DEFAULT '2024-25',
  notes           TEXT,
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
--  FEE INVOICE ITEMS  (line items within an invoice)
-- ============================================================
CREATE TABLE fee_invoice_items (
  id           SERIAL        PRIMARY KEY,
  invoice_id   INT           NOT NULL  REFERENCES fee_invoices(id) ON DELETE CASCADE,
  fee_head_id  INT                     REFERENCES fee_heads(id)    ON DELETE SET NULL,
  description  VARCHAR(150)  NOT NULL,
  amount       NUMERIC(10,2) NOT NULL  DEFAULT 0,
  is_waived    BOOLEAN       DEFAULT FALSE,
  created_at   TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
--  FEE PAYMENTS  (payment transactions against invoices)
-- ============================================================
CREATE TABLE fee_payments (
  id              SERIAL        PRIMARY KEY,
  receipt_no      VARCHAR(30)   UNIQUE,
  invoice_id      INT           NOT NULL  REFERENCES fee_invoices(id) ON DELETE RESTRICT,
  student_id      INT           NOT NULL  REFERENCES students(id)     ON DELETE CASCADE,
  amount          NUMERIC(10,2) NOT NULL,
  payment_date    DATE          NOT NULL  DEFAULT CURRENT_DATE,
  payment_method  VARCHAR(20)   NOT NULL  DEFAULT 'cash'
                  CHECK (payment_method IN ('cash','bank','online','cheque','dd')),
  bank_name       VARCHAR(100),
  transaction_ref VARCHAR(100),
  collected_by    INT                     REFERENCES teachers(id) ON DELETE SET NULL,
  remarks         TEXT,
  is_void         BOOLEAN       DEFAULT FALSE,
  voided_at       TIMESTAMPTZ,
  voided_reason   TEXT,
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- Fee indexes
CREATE INDEX idx_fee_invoices_student   ON fee_invoices(student_id);
CREATE INDEX idx_fee_invoices_class     ON fee_invoices(class_id);
CREATE INDEX idx_fee_invoices_month     ON fee_invoices(billing_month);
CREATE INDEX idx_fee_invoices_status    ON fee_invoices(status);
CREATE INDEX idx_fee_payments_invoice   ON fee_payments(invoice_id);
CREATE INDEX idx_fee_payments_student   ON fee_payments(student_id);
CREATE INDEX idx_fee_structures_class   ON fee_structures(class_id);

-- ============================================================
--  DEFAULT FEE HEADS SEED DATA
-- ============================================================
INSERT INTO fee_heads (name, category, sort_order) VALUES
  ('Admission Fee',    'admission', 1),
  ('Registration Fee', 'admission', 2),
  ('Security Deposit', 'admission', 3),
  ('Books Fee',        'admission', 4),
  ('Uniform Fee',      'admission', 5),
  ('Tuition Fee',      'monthly',   1),
  ('Transport Fee',    'monthly',   2),
  ('Hostel Fee',       'monthly',   3),
  ('Exam Fee',         'monthly',   4),
  ('Computer Fee',     'monthly',   5);
