import React, { useState, useEffect } from 'react';
import { Container, Alert, Button } from 'react-bootstrap';
import { FaSync, FaBug } from 'react-icons/fa';
import axios from 'axios';
import Header from './components/Header';
import PriceTable from './components/PriceTable';
import LoadingSpinner from './components/LoadingSpinner';

function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [products, setProducts] = useState([]);
  const [dates, setDates] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const API_BASE_URL = 'https://product-server-k38t.onrender.com';

  const fetchData = async () => {
    try {
      setError(null);
      const response = await axios.get(`${API_BASE_URL}/api/products`);
      
      setProducts(response.data.products || []);
      setDates(response.data.dates || []);
      setLastUpdate(new Date().toISOString());
    } catch (err) {
      console.error('Ошибка загрузки данных:', err);
      setError('Не удалось загрузить данные с сервера');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Container className="app-container">
        <LoadingSpinner />
      </Container>
    );
  }

  return (
    <Container fluid className="app-container">
      <Header 
        totalProducts={products.length} 
        lastUpdate={lastUpdate}
      />
      
      {error ? (
        <Alert variant="danger" className="mt-3">
          <Alert.Heading>
            <FaBug className="me-2" />
            Ошибка Price Hunter
          </Alert.Heading>
          <p>{error}</p>
          <Button 
            variant="outline-danger" 
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <FaSync className={`me-2 ${refreshing ? 'fa-spin' : ''}`} />
            Попробовать снова
          </Button>
        </Alert>
      ) : (
        <>
          <div className="d-flex justify-content-end mb-3">
            <Button 
              variant="outline-primary" 
              onClick={handleRefresh}
              disabled={refreshing}
              className="btn-hunter"
            >
              <FaSync className={`me-2 ${refreshing ? 'fa-spin' : ''}`} />
              Обновить данные
            </Button>
          </div>
          
          <PriceTable 
            products={products}
            dates={dates}
          />
        </>
      )}
    </Container>
  );
}

export default App;
