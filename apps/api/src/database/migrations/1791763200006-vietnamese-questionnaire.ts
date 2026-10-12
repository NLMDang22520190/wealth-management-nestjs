import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Vietnamese questionnaire as a NEW version; v1 content is never modified, it is only retired. Option order carries points 1-5. */
const questions = [
  ['Mục tiêu đầu tư', ['Bảo toàn vốn', 'Tạo thu nhập ổn định', 'Cân bằng giữa thu nhập và tăng trưởng', 'Tìm kiếm tăng trưởng dài hạn', 'Tối đa hóa tăng trưởng dài hạn']],
  ['Thời hạn đầu tư', ['Dưới một năm', 'Từ một đến hai năm', 'Từ hai đến năm năm', 'Từ năm đến mười năm', 'Trên mười năm']],
  ['Mức chấp nhận sụt giảm tạm thời', ['Không chấp nhận sụt giảm', 'Tối đa 5%', 'Tối đa 10%', 'Tối đa 20%', 'Trên 20%']],
  ['Phản ứng khi thị trường giảm', ['Thoát khỏi thị trường ngay lập tức', 'Giảm phần lớn mức đầu tư', 'Giữ nguyên kế hoạch hiện tại', 'Đầu tư thêm một khoản nhỏ', 'Tăng mạnh mức đầu tư']],
  ['Kinh nghiệm đầu tư', ['Chưa có kinh nghiệm', 'Chỉ gửi tiền tiết kiệm', 'Trái phiếu và quỹ đầu tư đa dạng', 'Cổ phiếu và quỹ cổ phiếu', 'Nhiều loại hình đầu tư biến động mạnh']],
  ['Mức độ ổn định của thu nhập', ['Rất bấp bênh', 'Khá bấp bênh', 'Tương đối ổn định', 'Ổn định', 'Rất ổn định với nhiều nguồn thu']],
  ['Quỹ dự phòng khẩn cấp', ['Chưa có quỹ dự phòng', 'Dưới ba tháng chi tiêu', 'Từ ba đến sáu tháng chi tiêu', 'Từ sáu đến mười hai tháng chi tiêu', 'Trên mười hai tháng chi tiêu']],
  ['Mức độ phụ thuộc vào khoản tiền đầu tư', ['Cần cho chi tiêu thiết yếu ngay bây giờ', 'Cần trong vòng một năm', 'Có thể cần trong vòng ba năm', 'Ít khả năng cần trong thời gian tới', 'Không cần cho các khoản chi tiêu có thể dự kiến']],
  ['Ưu tiên giữa lợi nhuận và biến động', ['Biến động thấp nhất', 'Lợi nhuận chủ yếu ổn định', 'Tăng trưởng và biến động ở mức vừa phải', 'Tăng trưởng cao hơn kèm biến động', 'Tiềm năng tăng trưởng cao nhất kèm biến động lớn']],
  ['Tỷ trọng tài sản dành cho đầu tư tăng trưởng', ['Rất ít', 'Một phần nhỏ', 'Một phần vừa phải', 'Một tỷ trọng lớn', 'Phần lớn tài sản có thể đầu tư của tôi']],
].map(([text, options], index) => ({ id: `q${index + 1}`, text,
  options: (options as string[]).map((option, optionIndex) => ({ id: `o${optionIndex + 1}`, text: option, points: optionIndex + 1 })) }));

export class VietnameseQuestionnaire1791763200006 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // Retire first: only one ACTIVE version may exist. Retirement is the transition the immutability trigger allows.
    await runner.query("UPDATE risk_questionnaire_versions SET status='RETIRED' WHERE version='demo-risk-v1'");
    await runner.query(`INSERT INTO risk_questionnaire_versions(version,questions,status,effective_from)
      VALUES($1,$2,'ACTIVE',$3)`, ['demo-risk-v2-vi', JSON.stringify(questions), '2026-01-10T00:00:00.000Z']);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DELETE FROM risk_questionnaire_versions WHERE version='demo-risk-v2-vi'`);
    await runner.query("UPDATE risk_questionnaire_versions SET status='ACTIVE' WHERE version='demo-risk-v1'");
  }
}
