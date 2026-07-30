import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { FiPhone, FiLock, FiArrowLeft } from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '../../../shared/store/authStore';
import { useCartStore } from '../../../shared/store/useStore';
import { useWishlistStore } from '../../../shared/store/wishlistStore';
import {
  clearPostLoginRedirect,
  consumePostLoginAction,
  getPostLoginRedirect,
} from '../../../shared/utils/postLoginAction';
import toast from 'react-hot-toast';
import MobileLayout from '../components/Layout/MobileLayout';
import PageTransition from '../../../shared/components/PageTransition';

const MobileLogin = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { sendOtpPhone, verifyOtpPhone, isLoading } = useAuthStore();
  
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState(1); // 1 = Phone Input, 2 = OTP Input

  const storedFrom = getPostLoginRedirect();
  const from = location.state?.from?.pathname || storedFrom || '/home';

  const replayPendingAction = () => {
    const action = consumePostLoginAction();
    if (!action?.type) return;

    if (action.type === 'cart:add' && action.payload) {
      useCartStore.getState().addItem(action.payload);
      return;
    }

    if (action.type === 'wishlist:add' && action.payload) {
      useWishlistStore.getState().addItem(action.payload);
    }
  };

  const handleSendOtp = async (e) => {
    if (e) e.preventDefault();
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
      toast.error('Please enter a valid 10-digit phone number.');
      return;
    }

    try {
      await sendOtpPhone(cleanPhone);
      toast.success('OTP sent successfully!');
      setStep(2);
    } catch (error) {
      toast.error(error?.response?.data?.message || error?.message || 'Failed to send OTP.');
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    const cleanPhone = phone.replace(/\D/g, '');
    if (otp.length !== 6) {
      toast.error('Please enter a 6-digit OTP.');
      return;
    }

    try {
      await verifyOtpPhone(cleanPhone, otp);
      replayPendingAction();
      toast.success('Login successful!');
      clearPostLoginRedirect();
      navigate(from === '/login' ? '/home' : from, { replace: true });
    } catch (error) {
      toast.error(error?.response?.data?.message || error?.message || 'Invalid OTP. Please try again.');
    }
  };

  const handlePhoneChange = (e) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 10);
    setPhone(val);
  };

  const handleOtpChange = (e) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 6);
    setOtp(val);
  };

  return (
    <PageTransition>
      <MobileLayout showBottomNav={false} showCartBar={false}>
        <div className="w-full min-h-screen flex items-start justify-center px-4 pt-12 pb-8 bg-gray-50">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="w-full max-w-md"
          >
            <div className="bg-white rounded-2xl p-6 shadow-md border border-gray-100">
              
              {/* Back Button for OTP Step */}
              {step === 2 && (
                <button
                  onClick={() => {
                    setStep(1);
                    setOtp('');
                  }}
                  className="flex items-center text-gray-500 hover:text-gray-800 transition-colors mb-6 text-sm font-medium"
                >
                  <FiArrowLeft className="mr-2" size={16} />
                  Change Phone Number
                </button>
              )}

              {/* Header */}
              <div className="text-center mb-8">
                <h1 className="text-2xl font-extrabold text-gray-900 mb-2 tracking-tight">
                  {step === 1 ? 'Welcome to Raathi' : 'Verify OTP'}
                </h1>
                <p className="text-sm text-gray-600 px-4">
                  {step === 1 
                    ? 'Enter your phone number to proceed' 
                    : `Enter the 6-digit verification code sent to +91 ${phone}`
                  }
                </p>
              </div>

              <AnimatePresence mode="wait">
                {step === 1 ? (
                  <motion.form
                    key="phone-step"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    onSubmit={handleSendOtp}
                    className="space-y-6"
                  >
                    <div>
                      <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">
                        Mobile Number
                      </label>
                      <div className="relative">
                        <div className="absolute left-4 top-1/2 transform -translate-y-1/2 flex items-center border-r border-gray-200 pr-2">
                          <FiPhone className="text-gray-400 mr-1.5" />
                          <span className="text-gray-600 text-sm font-semibold">+91</span>
                        </div>
                        <input
                          type="tel"
                          value={phone}
                          onChange={handlePhoneChange}
                          required
                          className="w-full pl-20 pr-4 py-3.5 rounded-xl border border-gray-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none transition-all text-base tracking-widest font-medium"
                          placeholder="9876543210"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isLoading || phone.length !== 10}
                      className="w-full bg-primary-500 hover:bg-primary-600 active:bg-primary-700 text-white py-3.5 rounded-xl font-bold text-base transition-all duration-300 hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isLoading ? 'Sending...' : 'Get OTP'}
                    </button>
                  </motion.form>
                ) : (
                  <motion.form
                    key="otp-step"
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    onSubmit={handleVerifyOtp}
                    className="space-y-6"
                  >
                    <div>
                      <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">
                        Verification Code (OTP)
                      </label>
                      <div className="relative">
                        <FiLock className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400" />
                        <input
                          type="text"
                          value={otp}
                          onChange={handleOtpChange}
                          required
                          className="w-full pl-12 pr-4 py-3.5 rounded-xl border border-gray-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none transition-all text-base tracking-widest text-center font-bold"
                          placeholder="******"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isLoading || otp.length !== 6}
                      className="w-full bg-primary-500 hover:bg-primary-600 active:bg-primary-700 text-white py-3.5 rounded-xl font-bold text-base transition-all duration-300 hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isLoading ? 'Verifying...' : 'Login'}
                    </button>

                    <div className="text-center pt-2">
                      <button
                        type="button"
                        onClick={handleSendOtp}
                        disabled={isLoading}
                        className="text-sm text-primary-600 hover:text-primary-700 font-semibold"
                      >
                        Resend OTP
                      </button>
                    </div>
                  </motion.form>
                )}
              </AnimatePresence>

            </div>
          </motion.div>
        </div>
      </MobileLayout>
    </PageTransition>
  );
};

export default MobileLogin;
