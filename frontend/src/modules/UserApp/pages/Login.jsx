import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { FiMail, FiLock, FiArrowLeft } from 'react-icons/fi';
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
  const { sendOtpEmail, verifyOtpEmail, isLoading } = useAuthStore();
  
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState(1); // 1 = Email Input, 2 = OTP Input

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
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      toast.error('Please enter a valid email address.');
      return;
    }

    try {
      await sendOtpEmail(cleanEmail);
      toast.success(`OTP sent to ${cleanEmail}! Please check your email inbox.`);
      setStep(2);
    } catch (error) {
      toast.error(error?.response?.data?.message || error?.message || 'Failed to send OTP to email.');
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    if (otp.length !== 6) {
      toast.error('Please enter a 6-digit OTP.');
      return;
    }

    try {
      const cleanEmail = email.trim().toLowerCase();
      await verifyOtpEmail(cleanEmail, otp);
      replayPendingAction();
      toast.success('Login successful!');
      clearPostLoginRedirect();
      navigate(from === '/login' ? '/home' : from, { replace: true });
    } catch (error) {
      toast.error(error?.response?.data?.message || error?.message || 'Invalid OTP. Please try again.');
    }
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
                  Change Email Address
                </button>
              )}

              {/* Header */}
              <div className="text-center mb-8">
                <h1 className="text-2xl font-extrabold text-gray-900 mb-2 tracking-tight">
                  {step === 1 ? 'Welcome to Raathi' : 'Verify Email OTP'}
                </h1>
                <p className="text-sm text-gray-600 px-4">
                  {step === 1 
                    ? 'Enter your email address to receive a verification OTP code' 
                    : `Enter the 6-digit code sent to ${email}`
                  }
                </p>
              </div>

              <AnimatePresence mode="wait">
                {step === 1 ? (
                  <motion.form
                    key="email-step"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    onSubmit={handleSendOtp}
                    className="space-y-6"
                  >
                    <div>
                      <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">
                        Email Address
                      </label>
                      <div className="relative">
                        <FiMail className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                          className="w-full pl-12 pr-4 py-3.5 rounded-xl border border-gray-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none transition-all text-base font-medium"
                          placeholder="your.email@gmail.com"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isLoading || !email.includes('@')}
                      className="w-full bg-primary-500 hover:bg-primary-600 active:bg-primary-700 text-white py-3.5 rounded-xl font-bold text-base transition-all duration-300 hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isLoading ? 'Sending OTP to Email...' : 'Get Email OTP'}
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
