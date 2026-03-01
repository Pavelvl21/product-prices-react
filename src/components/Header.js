import React from 'react';
import { Container, Row, Col } from 'react-bootstrap';
import { FaGithub, FaTelegram, FaEnvelope, FaChartLine } from 'react-icons/fa';

const Header = ({ totalProducts, lastUpdate }) => {
  const formattedDate = lastUpdate 
    ? new Date(lastUpdate).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : 'нет данных';

  return (
    <div className="hunter-header">
      <Container fluid>
        <Row className="align-items-center">
          <Col lg={8}>
            <h1 className="hunter-title">
              <FaChartLine className="me-3" />
              Price Hunter
            </h1>
            <div className="hunter-subtitle">
              Охотимся за лучшими ценами на 21vek.by
            </div>
            
            <div className="stats-container">
              <div className="stat-card">
                <div className="stat-value">{totalProducts}</div>
                <div className="stat-label">товаров в базе</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{formattedDate}</div>
                <div className="stat-label">последнее обновление</div>
              </div>
            </div>
          </Col>
          
          <Col lg={4} className="text-lg-end mt-4 mt-lg-0">
            <div className="hunter-badge mb-3">🔍 Beta v1.0</div>
            <div className="d-flex justify-content-lg-end gap-3">
              <a href="https://github.com" target="_blank" rel="noreferrer" className="text-white">
                <FaGithub size={24} />
              </a>
              <a href="https://t.me" target="_blank" rel="noreferrer" className="text-white">
                <FaTelegram size={24} />
              </a>
              <a href="mailto:hunter@price-hunter.com" className="text-white">
                <FaEnvelope size={24} />
              </a>
            </div>
          </Col>
        </Row>
      </Container>
    </div>
  );
};

export default Header;
