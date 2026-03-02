from sqlalchemy import Column, Integer, String, Date, ForeignKey, DateTime
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base

class ReceivingHeader(Base):
    __tablename__ = "receiving_headers"

    id = Column(Integer, primary_key=True, index=True)
    customer = Column(String(150), nullable=False)
    receiving_date = Column(Date, nullable=False)
    warehouse_id = Column(Integer, ForeignKey("warehouses.id"), nullable=False)
    reference_no = Column(String(100), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    lines = relationship("ReceivingLine", back_populates="header", cascade="all, delete-orphan")

class ReceivingLine(Base):
    __tablename__ = "receiving_lines"

    id = Column(Integer, primary_key=True, index=True)
    receiving_id = Column(Integer, ForeignKey("receiving_headers.id"), nullable=False)
    item_id = Column(Integer, ForeignKey("items.id"), nullable=False)
    location_id = Column(Integer, ForeignKey("locations.id"), nullable=False)
    quantity = Column(Integer, nullable=False)

    batch_no = Column(String(100), nullable=True)
    manufacturing_date = Column(Date, nullable=True)
    expiry_date = Column(Date, nullable=True)
    shelf_expiry_date = Column(Date, nullable=True)
    status = Column(String(20), nullable=False)

    header = relationship("ReceivingHeader", back_populates="lines")